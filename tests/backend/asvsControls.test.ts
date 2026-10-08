import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBackendTestServer } from './testServer';

// Security-behavior contracts that pin the CURRENT behavior of controls that no other test exercised
// (mutation survivors G01-G05, G08, G10, M11c in docs/test-temel/ajan1-backend.md section 4.1).
// All secrets below are random per test run (F-1: min 32 bytes, no committed secret). Known gaps (docs/test-temel/ajan5-guvenlik.md F-1..F-4)
// are deliberately NOT asserted here.

const TEST_SECRET = randomBytes(48).toString('hex');
const ATTACKER_SECRET = randomBytes(48).toString('hex');

type TestServerOptions = Parameters<typeof withBackendTestServer>[1];

async function withTestServer(handler: (baseUrl: string) => Promise<void>, options: TestServerOptions = {}) {
    await withBackendTestServer(handler, { jwtSecret: TEST_SECRET, seedCompliance: false, ...options });
}

function post(baseUrl: string, path: string, body: unknown) {
    return fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function register(baseUrl: string, email: string, password = 'password123') {
    // F-2: register returns a uniform 202 (no token); to get a token, sign in with the same credentials.
    const registerResponse = await post(baseUrl, '/api/auth/register', { email, password });
    expect(registerResponse.status).toBe(202);
    const response = await post(baseUrl, '/api/auth/login', { email, password });
    const payload = await response.json();
    expect(response.status).toBe(200);
    return payload as { token: string; user: { id: string; email: string; role: string } };
}

describe('ASVS security controls', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
        savedEnv = { JWT_SECRET: process.env.JWT_SECRET, NODE_ENV: process.env.NODE_ENV };
        process.env.JWT_SECRET = TEST_SECRET;
        process.env.NODE_ENV = 'test';
        // The app writes one JSON log line per request; routing hundreds of them through the test
        // reporter costs more than the requests themselves.
        for (const method of ['log', 'warn', 'error'] as const) {
            vi.spyOn(console, method).mockImplementation(() => undefined);
        }
    });

    afterEach(() => {
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    describe('self-contained tokens (ASVS 4.0.3 V3.5.3 / 5.0.0 V9.1.1, V9.2.1)', () => {
        const identity = { id: 'user-1', email: 'user@example.com', role: 'ANALYST' as const };

        it('verifyJwt rejects tokens signed with another key, unsigned tokens, and tampered payloads', async () => {
            const { signJwt, verifyJwt } = await import('../../server/shared/auth/jwt');
            const valid = signJwt(identity);
            expect(verifyJwt(valid).id).toBe('user-1');

            const wrongKey = jwt.sign(identity, ATTACKER_SECRET, { expiresIn: '1h' });
            expect(() => verifyJwt(wrongKey)).toThrow();

            const unsigned = jwt.sign(identity, '', { algorithm: 'none' });
            expect(() => verifyJwt(unsigned)).toThrow();

            // Swap the payload for an ADMIN claim while keeping the original signature.
            const [header, , signature] = valid.split('.');
            const forgedPayload = Buffer.from(JSON.stringify({ ...identity, role: 'ADMIN', exp: 4_102_444_800 })).toString('base64url');
            expect(() => verifyJwt(`${header}.${forgedPayload}.${signature}`)).toThrow();
        });

        it('signJwt issues an expiring token and verifyJwt rejects an expired one', async () => {
            const { signJwt, verifyJwt } = await import('../../server/shared/auth/jwt');

            const claims = jwt.decode(signJwt(identity)) as { iat: number; exp?: number };
            expect(claims.exp).toEqual(expect.any(Number));
            expect(claims.exp! - claims.iat).toBe(24 * 60 * 60);

            const shortLived = jwt.decode(signJwt(identity, '15m')) as { iat: number; exp?: number };
            expect(shortLived.exp! - shortLived.iat).toBe(15 * 60);

            const nowSeconds = Math.floor(Date.now() / 1000);
            const expired = jwt.sign({ ...identity, iat: nowSeconds - 7200, exp: nowSeconds - 3600 }, TEST_SECRET);
            expect(() => verifyJwt(expired)).toThrow(/expired/i);
        });

        it('the API answers 401 to forged, expired, and malformed bearer tokens but accepts a genuine one', async () => {
            await withTestServer(async (baseUrl) => {
                const registered = await register(baseUrl, 'tokens@example.com');
                const claims = jwt.decode(registered.token) as Record<string, unknown>;
                const genuine = await fetch(`${baseUrl}/api/portfolio/state`, {
                    headers: { Authorization: `Bearer ${registered.token}` },
                });
                expect(genuine.status).toBe(200);

                const nowSeconds = Math.floor(Date.now() / 1000);
                const forged = jwt.sign(claims, ATTACKER_SECRET);
                const expired = jwt.sign({ ...claims, iat: nowSeconds - 7200, exp: nowSeconds - 3600 }, TEST_SECRET);
                for (const token of [forged, expired, 'not-a-jwt']) {
                    const response = await fetch(`${baseUrl}/api/portfolio/state`, {
                        headers: { Authorization: `Bearer ${token}` },
                    });
                    expect(response.status).toBe(401);
                    expect((await response.json()).success).toBe(false);
                }
            });
        });
    });

    describe('password handling (ASVS 5.0.0 V6.2.1, V6.3.8)', () => {
        it('rejects a wrong password and an unknown account with the same 401 and no token', async () => {
            await withTestServer(async (baseUrl) => {
                await register(baseUrl, 'login@example.com', 'correct-password');

                const wrongPassword = await post(baseUrl, '/api/auth/login', { email: 'login@example.com', password: 'wrong-password' });
                const wrongPayload = await wrongPassword.json();
                const unknownAccount = await post(baseUrl, '/api/auth/login', { email: 'nobody@example.com', password: 'correct-password' });
                const unknownPayload = await unknownAccount.json();

                expect(wrongPassword.status).toBe(401);
                expect(unknownAccount.status).toBe(401);
                expect(wrongPayload).toEqual({ success: false, error: 'Invalid credentials' });
                expect(unknownPayload).toEqual(wrongPayload);

                const correct = await post(baseUrl, '/api/auth/login', { email: 'login@example.com', password: 'correct-password' });
                expect(correct.status).toBe(200);
            });
        });

        it('refuses to create accounts with passwords shorter than 8 characters', async () => {
            await withTestServer(async (baseUrl) => {
                for (const password of ['', 'a', 'short12', '1234567']) {
                    const response = await post(baseUrl, '/api/auth/register', { email: 'short@example.com', password });
                    const payload = await response.json();
                    expect(response.status, JSON.stringify(password)).toBe(400);
                    expect(payload.success).toBe(false);
                    expect(payload.token).toBeUndefined();
                }
            });
        });
    });

    describe('rate limiting (ASVS 4.0.3 V2.2.1 / 5.0.0 V2.4.1, V6.3.1)', () => {
        it('answers 429 to a flood of API requests from one client', async () => {
            await withTestServer(async (baseUrl) => {
                // Unknown /api routes are the cheapest requests there are, and the shared /api limiter
                // counts every request, matched route or not. 301 sequential requests (~0.4 s) are enough
                // to cross the 300 limit; the limiter is deterministic about HOW MANY pass, not which ones.
                const responses: Response[] = [];
                for (let attempt = 0; attempt < 301; attempt += 1) {
                    responses.push(await fetch(`${baseUrl}/api/no-such-route`));
                }
                const throttled = responses.filter((response) => response.status === 429);
                const passed = responses.filter((response) => response.status !== 429);

                expect(throttled.length, 'no 429 within 301 requests').toBeGreaterThan(0);
                expect(passed.length).toBeLessThanOrEqual(300);
                expect(passed.every((response) => response.status === 404)).toBe(true);
                expect(await throttled[0].json()).toEqual({ success: false, error: 'Too many requests, please try again later.' });
            });
        });
    });

    describe('browser-facing headers (ASVS 4.0.3 V14.4 / V14.5.3, 5.0.0 V3.4)', () => {
        it('sets hardening headers on every response and does not advertise Express', async () => {
            await withTestServer(async (baseUrl) => {
                const response = await fetch(`${baseUrl}/health`);

                expect(response.status).toBe(200);
                expect(response.headers.get('x-content-type-options')).toBe('nosniff');
                expect(response.headers.get('x-powered-by')).toBeNull();
                expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
                expect(response.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
                expect(response.headers.get('referrer-policy')).toBeTruthy();
            });
        });

        it('never reflects a CORS origin that is not on the allow-list (default list)', async () => {
            await withTestServer(async (baseUrl) => {
                for (const origin of ['https://evil.example', 'null', 'http://localhost:3000.evil.example']) {
                    const simple = await fetch(`${baseUrl}/no-such-route`, { headers: { Origin: origin } });
                    const preflight = await fetch(`${baseUrl}/api/auth/login`, {
                        method: 'OPTIONS',
                        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
                    });
                    expect(simple.headers.get('access-control-allow-origin'), origin).toBeNull();
                    expect(preflight.headers.get('access-control-allow-origin'), origin).toBeNull();
                }

                const allowed = await fetch(`${baseUrl}/no-such-route`, { headers: { Origin: 'http://localhost:5173' } });
                expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
            }, { env: { CORS_ORIGINS: undefined } });
        });

        it('honours CORS_ORIGINS exactly: configured origin allowed, default dev origins no longer allowed', async () => {
            await withTestServer(async (baseUrl) => {
                const configured = await fetch(`${baseUrl}/no-such-route`, { headers: { Origin: 'https://app.example.test' } });
                const devDefault = await fetch(`${baseUrl}/no-such-route`, { headers: { Origin: 'http://localhost:5173' } });
                const evil = await fetch(`${baseUrl}/no-such-route`, { headers: { Origin: 'https://evil.example' } });

                expect(configured.headers.get('access-control-allow-origin')).toBe('https://app.example.test');
                expect(devDefault.headers.get('access-control-allow-origin')).toBeNull();
                expect(evil.headers.get('access-control-allow-origin')).toBeNull();
            }, { env: { CORS_ORIGINS: 'https://app.example.test' } });
        });
    });

    describe('compliance fails closed (ASVS 5.0.0 V16.5.2)', () => {
        it('returns 503 COMPLIANCE_DATA_UNAVAILABLE and does not run the AI route when the restricted list cannot be loaded', async () => {
            await withTestServer(async (baseUrl) => {
                const { token } = await register(baseUrl, 'failclosed@example.com');
                const response = await fetch(`${baseUrl}/api/ai/analyze`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ headline: 'AMD expands data center roadmap' }),
                });
                const payload = await response.json();

                expect(response.status).toBe(503);
                expect(payload.success).toBe(false);
                expect(payload.error).toBe('COMPLIANCE_DATA_UNAVAILABLE');
                expect(payload.failureStage).toBe('compliance');
                expect(payload.provenance.sourceType).toBe('compliance');
                // The AI route never ran and the internal failure reason is not leaked (ASVS V16.5.1).
                expect(payload.analysis).toBeUndefined();
                expect(JSON.stringify(payload)).not.toContain('restricted-list-store-offline');
            }, {
                beforeImport: () => {
                    vi.doMock('../../server/services/complianceRepository', async (importOriginal) => ({
                        ...(await importOriginal<typeof import('../../server/services/complianceRepository')>()),
                        getRestrictedTickersSet: vi.fn().mockRejectedValue(new Error('restricted-list-store-offline')),
                    }));
                },
            });
        });
    });
});
