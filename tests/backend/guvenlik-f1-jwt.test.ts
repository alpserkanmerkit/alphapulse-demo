import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBackendTestServer } from './testServer';

// F-1 (HIGH): falling back to the committed plaintext development secret when JWT_SECRET is unset + algorithm/iss/aud not pinned.
// Details: docs/test-temel/ajan5-guvenlik.md (F-1, ASVS 2.10.4, 3.5.3), RAPOR.md section 5.
// This file holds no fixed valid secret: all secrets are generated at runtime with crypto.randomBytes.
// The retired legacy development secret itself is NOT kept in the repo (08.10, owner decision #70); only its SHA-256 digest
// is kept, and the test verifies that the server source contains no text equal to it. Forged tokens use a random attacker secret.

// The value below is NOT a secret: it is the one-way SHA-256 digest of the retired secret (gitleaks generic-api-key false positive).
const LEGACY_DEV_SECRET_SHA256 = '74da576ec5ee6e142e5c032864e4cfd764d6d8eb1aaa7889924fae90df8042d2'; // gitleaks:allow
const LEGACY_DEV_SECRET_LENGTH = 21;
const attackerSecret = () => randomBytes(32).toString('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
// The digest of every LEGACY_DEV_SECRET_LENGTH-long slice of the source is compared with the legacy secret's digest.
const containsLegacySecret = (source: string) => {
    for (let start = 0; start + LEGACY_DEV_SECRET_LENGTH <= source.length; start++) {
        if (sha256(source.slice(start, start + LEGACY_DEV_SECRET_LENGTH)) === LEGACY_DEV_SECRET_SHA256) return true;
    }
    return false;
};
const strongSecret = () => randomBytes(48).toString('hex');
const identity = { id: 'user-1', email: 'user@example.com', role: 'ANALYST' as const };

type EnvKey = 'JWT_SECRET' | 'NODE_ENV';

describe('F-1 JWT secret and verification hardening', () => {
    let savedEnv: Record<EnvKey, string | undefined>;

    function setEnv(key: EnvKey, value: string | undefined) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }

    async function loadJwt() {
        vi.resetModules();
        return import('../../server/shared/auth/jwt');
    }

    beforeEach(() => {
        savedEnv = { JWT_SECRET: process.env.JWT_SECRET, NODE_ENV: process.env.NODE_ENV };
        for (const method of ['log', 'warn'] as const) {
            vi.spyOn(console, method).mockImplementation(() => undefined);
        }
    });

    afterEach(() => {
        setEnv('JWT_SECRET', savedEnv.JWT_SECRET);
        setEnv('NODE_ENV', savedEnv.NODE_ENV);
        // db.ts caches the prisma client on globalThis when NODE_ENV=development; keep it from leaking into later tests.
        delete (globalThis as { prisma?: unknown }).prisma;
        vi.resetModules();
    });

    describe('secret is mandatory', () => {
        it('source code has no fixed secret / development-secret fallback left', () => {
            const source = readFileSync('server/shared/auth/jwt.ts', 'utf8');
            expect(source.length).toBeGreaterThan(LEGACY_DEV_SECRET_LENGTH);
            expect(containsLegacySecret(source)).toBe(false);
            expect(source).not.toMatch(/DEV_JWT_SECRET/);
        });

        it.each(['development', 'production', 'staging', undefined])(
            'without JWT_SECRET, NODE_ENV=%s rejects both sign and verify (no fallback to a development secret)',
            async (nodeEnv) => {
                setEnv('NODE_ENV', nodeEnv);
                setEnv('JWT_SECRET', undefined);
                const { signJwt, verifyJwt } = await loadJwt();

                expect(() => signJwt(identity)).toThrow(/JWT_SECRET/);
                const forgedWithLegacy = jwt.sign(identity, attackerSecret(), { expiresIn: '1h' });
                expect(() => verifyJwt(forgedWithLegacy)).toThrow();
            }
        );

        it.each(['development', 'production'])(
            'NODE_ENV=%s rejects a secret shorter than 32 bytes',
            async (nodeEnv) => {
                setEnv('NODE_ENV', nodeEnv);
                setEnv('JWT_SECRET', randomBytes(15).toString('hex')); // 30 bytes
                const { signJwt } = await loadJwt();

                expect(() => signJwt(identity)).toThrow(/JWT_SECRET/);
            }
        );

        it('a secret of exactly 32 bytes is accepted', async () => {
            setEnv('NODE_ENV', 'development');
            setEnv('JWT_SECRET', randomBytes(16).toString('hex')); // 32 bytes
            const { signJwt, verifyJwt } = await loadJwt();

            expect(verifyJwt(signJwt(identity)).id).toBe('user-1');
        });

        it('even with NODE_ENV=test and no secret, a token signed with the legacy development secret is rejected', async () => {
            setEnv('NODE_ENV', 'test');
            setEnv('JWT_SECRET', undefined);
            const { verifyJwt } = await loadJwt();

            const forgedWithLegacy = jwt.sign(identity, attackerSecret(), { expiresIn: '1h' });
            expect(() => verifyJwt(forgedWithLegacy)).toThrow();
        });
    });

    describe('pinning algorithm, expiry, iss and aud', () => {
        let secret: string;

        beforeEach(() => {
            secret = strongSecret();
            setEnv('NODE_ENV', 'test');
            setEnv('JWT_SECRET', secret);
        });

        async function genuine() {
            const { signJwt, verifyJwt } = await loadJwt();
            const token = signJwt(identity);
            const claims = jwt.decode(token) as Record<string, unknown>;
            return { token, claims, verifyJwt };
        }

        it('signJwt issues a token with HS256, iss, aud and exp; verifyJwt returns it', async () => {
            const { token, claims, verifyJwt } = await genuine();
            const decoded = jwt.decode(token, { complete: true });

            expect(decoded?.header.alg).toBe('HS256');
            expect(claims.iss).toEqual(expect.any(String));
            expect(claims.aud).toEqual(expect.any(String));
            expect(claims.exp).toEqual(expect.any(Number));
            expect(verifyJwt(token)).toMatchObject({ id: 'user-1', email: 'user@example.com', role: 'ANALYST' });
        });

        it('a token signed with HS512 (correct secret, correct iss/aud/exp) is rejected', async () => {
            const { claims, verifyJwt } = await genuine();
            const hs512 = jwt.sign(claims, secret, { algorithm: 'HS512' });
            expect(() => verifyJwt(hs512)).toThrow();
        });

        it('an alg:none (unsigned) token is rejected', async () => {
            const { claims, verifyJwt } = await genuine();
            const unsigned = jwt.sign(claims, '', { algorithm: 'none' });
            expect(() => verifyJwt(unsigned)).toThrow();
        });

        it('a token signed with the wrong secret is rejected', async () => {
            const { claims, verifyJwt } = await genuine();
            const wrongSecret = jwt.sign(claims, strongSecret(), { algorithm: 'HS256' });
            expect(() => verifyJwt(wrongSecret)).toThrow();
        });

        it('an expired token is rejected', async () => {
            const { claims, verifyJwt } = await genuine();
            const now = Math.floor(Date.now() / 1000);
            const expired = jwt.sign({ ...claims, iat: now - 7200, exp: now - 3600 }, secret, { algorithm: 'HS256' });
            expect(() => verifyJwt(expired)).toThrow(/expired/i);
        });

        it('a token without an exp claim (never expires) is rejected', async () => {
            const { claims, verifyJwt } = await genuine();
            const { exp: _exp, ...withoutExp } = claims;
            const noExp = jwt.sign(withoutExp, secret, { algorithm: 'HS256' });
            expect(jwt.decode(noExp)).not.toHaveProperty('exp');
            expect(() => verifyJwt(noExp)).toThrow();
        });

        it('a token with a wrong or missing iss / aud is rejected', async () => {
            const { claims, verifyJwt } = await genuine();
            const { iss: _iss, aud: _aud, ...bare } = claims;
            const sign = (payload: Record<string, unknown>) => jwt.sign(payload, secret, { algorithm: 'HS256' });

            expect(() => verifyJwt(sign({ ...claims, iss: 'other-issuer' }))).toThrow();
            expect(() => verifyJwt(sign({ ...claims, aud: 'other-audience' }))).toThrow();
            expect(() => verifyJwt(sign({ ...bare, aud: claims.aud }))).toThrow();
            expect(() => verifyJwt(sign({ ...bare, iss: claims.iss }))).toThrow();
            expect(() => verifyJwt(sign(bare))).toThrow();
        });
    });

    describe('HTTP: protected endpoint (GET /api/teams)', () => {
        it('without JWT_SECRET in development, a token signed with the legacy development secret gets 401', async () => {
            await withBackendTestServer(
                async (baseUrl) => {
                    // The user really exists, so if the forged token were accepted the endpoint would return 200 (the vulnerability as it was).
                    const { prisma } = await import('../../server/shared/db/db');
                    const user = await prisma.user.create({ data: { email: 'f1-dev@example.com', password: 'x', name: 'f1' } });
                    const forged = jwt.sign(
                        { id: user.id, email: user.email, role: 'ANALYST', teamId: null, teamRole: null },
                        attackerSecret(),
                        { expiresIn: '1h' }
                    );
                    const response = await fetch(`${baseUrl}/api/teams`, { headers: { Authorization: `Bearer ${forged}` } });
                    expect(response.status).toBe(401);
                },
                { seedCompliance: false, env: { NODE_ENV: 'development', JWT_SECRET: undefined } }
            );
        });

        it('a genuine token gets 200; HS512 / missing iss-aud / missing exp forged tokens get 401', async () => {
            const secret = strongSecret();
            await withBackendTestServer(
                async (baseUrl) => {
                    const credentials = JSON.stringify({ email: 'f1@example.com', password: 'password123' });
                    const jsonHeaders = { 'Content-Type': 'application/json' };
                    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: jsonHeaders, body: credentials });
                    expect(registerResponse.status).toBe(202);
                    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: jsonHeaders, body: credentials });
                    expect(loginResponse.status).toBe(200);
                    const { token } = (await loginResponse.json()) as { token: string };
                    const claims = jwt.decode(token) as Record<string, unknown>;
                    const { iss: _iss, aud: _aud, exp: _exp, ...bare } = claims;

                    const statusFor = async (candidate: string) =>
                        (await fetch(`${baseUrl}/api/teams`, { headers: { Authorization: `Bearer ${candidate}` } })).status;

                    expect(await statusFor(token)).toBe(200);
                    expect(await statusFor(jwt.sign(claims, secret, { algorithm: 'HS512' }))).toBe(401);
                    expect(await statusFor(jwt.sign({ ...bare, exp: claims.exp }, secret, { algorithm: 'HS256' }))).toBe(401);
                    expect(await statusFor(jwt.sign({ ...bare, iss: claims.iss, aud: claims.aud }, secret, { algorithm: 'HS256' }))).toBe(401);
                },
                { jwtSecret: secret, seedCompliance: false }
            );
        });
    });
});
