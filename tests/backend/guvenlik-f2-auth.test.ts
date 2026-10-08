import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBackendTestServer } from './testServer';

// F-2 (HIGH): login/register hardening against credential attacks.
// ASVS 2.1.x (password upper bound), 2.2.1 (anti-automation defences).
// Test passwords are generated at runtime; the source holds no fixed password.

const TIMEOUT_MS = 60_000;
const LOCK_THRESHOLD = 5;

function randomPassword(): string {
    return `Pw-${randomBytes(12).toString('hex')}`;
}

function post(baseUrl: string, path: string, body: unknown) {
    return fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

async function withServer(
    handler: (baseUrl: string) => Promise<void>,
    options: Parameters<typeof withBackendTestServer>[1] = {}
) {
    await withBackendTestServer(handler, { jwtSecret: randomBytes(48).toString('hex'), seedCompliance: false, ...options });
}

describe('F-2 authentication hardening', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.doUnmock('bcryptjs');
        vi.resetModules();
        vi.clearAllMocks();
    });

    describe('password upper bound', () => {
        it('rejects a password longer than 128 characters with 400 on register and login; 128 characters is accepted', async () => {
            await withServer(async (baseUrl) => {
                const tooLong = randomBytes(65).toString('hex'); // 130 characters
                expect(tooLong.length).toBeGreaterThan(128);

                const registerLong = await post(baseUrl, '/api/auth/register', { email: 'long@example.com', password: tooLong });
                expect(registerLong.status).toBe(400);

                const loginLong = await post(baseUrl, '/api/auth/login', { email: 'long@example.com', password: tooLong });
                expect(loginLong.status).toBe(400);

                const exactly128 = randomBytes(64).toString('hex');
                expect(exactly128.length).toBe(128);
                const registerOk = await post(baseUrl, '/api/auth/register', { email: 'boundary@example.com', password: exactly128 });
                expect(registerOk.status).not.toBe(400);
            });
        }, TIMEOUT_MS);

        it('min length (8) is unchanged: 7 characters is rejected', async () => {
            await withServer(async (baseUrl) => {
                const response = await post(baseUrl, '/api/auth/register', { email: 'short@example.com', password: 'abc1234' });
                expect(response.status).toBe(400);
            });
        }, TIMEOUT_MS);
    });

    describe('per-account lockout', () => {
        it(`after ${LOCK_THRESHOLD} consecutive failed logins even the correct password gets the lock response`, async () => {
            await withServer(async (baseUrl) => {
                const password = randomPassword();
                const email = 'lock@example.com';
                await post(baseUrl, '/api/auth/register', { email, password });

                for (let attempt = 0; attempt < LOCK_THRESHOLD; attempt += 1) {
                    const bad = await post(baseUrl, '/api/auth/login', { email, password: randomPassword() });
                    expect(bad.status).toBe(401);
                }

                const locked = await post(baseUrl, '/api/auth/login', { email, password });
                const lockedBody = await locked.json();
                expect(locked.status).toBe(429);
                expect(lockedBody.success).toBe(false);
                expect(lockedBody.token).toBeUndefined();
            });
        }, TIMEOUT_MS);

        it('the lock response is identical for a non-existent account (user existence does not leak)', async () => {
            await withServer(async (baseUrl) => {
                const password = randomPassword();
                await post(baseUrl, '/api/auth/register', { email: 'exists@example.com', password });

                const results: Array<{ status: number; body: unknown }> = [];
                for (const email of ['exists@example.com', 'missing@example.com']) {
                    for (let attempt = 0; attempt < LOCK_THRESHOLD; attempt += 1) {
                        await post(baseUrl, '/api/auth/login', { email, password: randomPassword() });
                    }
                    const locked = await post(baseUrl, '/api/auth/login', { email, password: randomPassword() });
                    results.push({ status: locked.status, body: await locked.json() });
                }

                expect(results[0].status).toBe(429);
                expect(results[1].status).toBe(results[0].status);
                expect(results[1].body).toEqual(results[0].body);
            });
        }, TIMEOUT_MS);

        it('a successful login resets the counter; the lock does not affect another account', async () => {
            await withServer(async (baseUrl) => {
                const password = randomPassword();
                const email = 'counter@example.com';
                await post(baseUrl, '/api/auth/register', { email, password });
                await post(baseUrl, '/api/auth/register', { email: 'other@example.com', password });

                for (let round = 0; round < 2; round += 1) {
                    for (let attempt = 0; attempt < LOCK_THRESHOLD - 1; attempt += 1) {
                        const bad = await post(baseUrl, '/api/auth/login', { email, password: randomPassword() });
                        expect(bad.status).toBe(401);
                    }
                    const ok = await post(baseUrl, '/api/auth/login', { email, password });
                    expect(ok.status).toBe(200);
                }

                for (let attempt = 0; attempt < LOCK_THRESHOLD; attempt += 1) {
                    await post(baseUrl, '/api/auth/login', { email, password: randomPassword() });
                }
                const other = await post(baseUrl, '/api/auth/login', { email: 'other@example.com', password });
                expect(other.status).toBe(200);
            });
        }, TIMEOUT_MS);

        it('the lock cannot be bypassed with email case or whitespace variations', async () => {
            await withServer(async (baseUrl) => {
                const password = randomPassword();
                await post(baseUrl, '/api/auth/register', { email: 'norm@example.com', password });
                const variants = ['norm@example.com', 'NORM@example.com', ' Norm@Example.com', 'norm@EXAMPLE.com', 'NORM@EXAMPLE.COM'];
                for (const email of variants) {
                    await post(baseUrl, '/api/auth/login', { email, password: randomPassword() });
                }
                const locked = await post(baseUrl, '/api/auth/login', { email: 'norm@example.com', password });
                expect(locked.status).toBe(429);
            });
        }, TIMEOUT_MS);
    });

    describe('account enumeration on register', () => {
        it('registering an existing email is externally indistinguishable from registering a new one', async () => {
            await withServer(async (baseUrl) => {
                const password = randomPassword();
                const first = await post(baseUrl, '/api/auth/register', { email: 'enum@example.com', password, name: 'First' });
                const firstBody = await first.json();

                const duplicate = await post(baseUrl, '/api/auth/register', { email: 'enum@example.com', password: randomPassword(), name: 'Second' });
                const duplicateBody = await duplicate.json();

                const fresh = await post(baseUrl, '/api/auth/register', { email: 'fresh@example.com', password, name: 'Fresh' });
                const freshBody = await fresh.json();

                expect(duplicate.status).toBe(first.status);
                expect(fresh.status).toBe(first.status);
                expect(duplicate.status).not.toBe(409);
                expect(duplicateBody).toEqual(firstBody);
                expect(freshBody).toEqual(firstBody);
                expect(duplicateBody.token).toBeUndefined();
                expect(duplicateBody.user).toBeUndefined();
            });
        }, TIMEOUT_MS);

        it('login works with the same credentials after registering; re-registering does not change an existing account password', async () => {
            await withServer(async (baseUrl) => {
                const password = randomPassword();
                const email = 'unchanged@example.com';
                await post(baseUrl, '/api/auth/register', { email, password });

                const login = await post(baseUrl, '/api/auth/login', { email, password });
                expect(login.status).toBe(200);

                const attackerPassword = randomPassword();
                await post(baseUrl, '/api/auth/register', { email, password: attackerPassword });

                const loginAfter = await post(baseUrl, '/api/auth/login', { email, password });
                expect(loginAfter.status).toBe(200);
                const attackerLogin = await post(baseUrl, '/api/auth/login', { email, password: attackerPassword });
                expect(attackerLogin.status).toBe(401);
            });
        }, TIMEOUT_MS);
    });

    describe('login timing equalization', () => {
        it('bcrypt.compare is called even when the user does not exist (with a dummy hash)', async () => {
            const compareSpy = vi.fn();
            await withServer(
                async (baseUrl) => {
                    const response = await post(baseUrl, '/api/auth/login', { email: 'ghost@example.com', password: randomPassword() });
                    expect(response.status).toBe(401);
                    expect(compareSpy).toHaveBeenCalledTimes(1);
                },
                {
                    beforeImport: () => {
                        vi.doMock('bcryptjs', async () => {
                            const actual = await vi.importActual<typeof import('bcryptjs')>('bcryptjs');
                            const real = actual.default ?? actual;
                            const wrapped = {
                                ...real,
                                compare: (...args: Parameters<typeof real.compare>) => {
                                    compareSpy();
                                    return (real.compare as (...a: unknown[]) => Promise<boolean>)(...args);
                                },
                            };
                            return { ...actual, default: wrapped, compare: wrapped.compare };
                        });
                    },
                }
            );
        }, TIMEOUT_MS);
    });

    describe('audit log', () => {
        it('failed logins (unknown account and wrong password) produce audit events; the password is never logged', async () => {
            await withServer(async (baseUrl) => {
                const password = randomPassword();
                await post(baseUrl, '/api/auth/register', { email: 'audit@example.com', password });

                const wrongPassword = randomPassword();
                const wrong = await post(baseUrl, '/api/auth/login', { email: 'audit@example.com', password: wrongPassword });
                expect(wrong.status).toBe(401);
                const unknownPassword = randomPassword();
                const unknown = await post(baseUrl, '/api/auth/login', { email: 'unknown@example.com', password: unknownPassword });
                expect(unknown.status).toBe(401);

                const { prisma } = await import('../../server/shared/db/db');
                const events = await prisma.auditEvent.findMany({ where: { category: 'auth', outcome: 'failure' } });
                expect(events.length).toBeGreaterThanOrEqual(2);
                expect(events.every((event) => event.action === 'Login Failed')).toBe(true);

                const serialized = JSON.stringify(events);
                for (const secret of [password, wrongPassword, unknownPassword]) {
                    expect(serialized).not.toContain(secret);
                }
            });
        }, TIMEOUT_MS);

        it('locked attempts are also written to the audit log as "blocked"', async () => {
            await withServer(async (baseUrl) => {
                const email = 'lockaudit@example.com';
                for (let attempt = 0; attempt < LOCK_THRESHOLD; attempt += 1) {
                    await post(baseUrl, '/api/auth/login', { email, password: randomPassword() });
                }
                const locked = await post(baseUrl, '/api/auth/login', { email, password: randomPassword() });
                expect(locked.status).toBe(429);

                const { prisma } = await import('../../server/shared/db/db');
                const blocked = await prisma.auditEvent.findMany({ where: { category: 'auth', outcome: 'blocked' } });
                expect(blocked.length).toBeGreaterThanOrEqual(1);
            });
        }, TIMEOUT_MS);
    });
});

describe('F-2 loginThrottle unit', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('locks once the threshold is reached and releases both lock and counter when the window ends', async () => {
        const throttle = await import('../../server/shared/auth/loginThrottle');
        const key = 'window@example.com';
        const t0 = 1_000_000;

        for (let attempt = 0; attempt < throttle.LOGIN_MAX_FAILURES - 1; attempt += 1) {
            expect(throttle.recordLoginFailure(key, t0 + attempt)).toBe(false);
            expect(throttle.getLoginLockRemainingMs(key, t0 + attempt)).toBe(0);
        }
        const lockAt = t0 + 10;
        expect(throttle.recordLoginFailure(key, lockAt)).toBe(true);
        expect(throttle.getLoginLockRemainingMs(key, lockAt + 1000)).toBe(throttle.LOGIN_LOCK_WINDOW_MS - 1000);

        const afterWindow = lockAt + throttle.LOGIN_LOCK_WINDOW_MS;
        expect(throttle.getLoginLockRemainingMs(key, afterWindow)).toBe(0);
        // The counter must be reset too: a single failed attempt must not lock.
        expect(throttle.recordLoginFailure(key, afterWindow + 1)).toBe(false);
        expect(throttle.getLoginLockRemainingMs(key, afterWindow + 1)).toBe(0);
    });

    it('a successful login resets the counter', async () => {
        const throttle = await import('../../server/shared/auth/loginThrottle');
        const key = 'reset@example.com';
        for (let attempt = 0; attempt < throttle.LOGIN_MAX_FAILURES - 1; attempt += 1) {
            throttle.recordLoginFailure(key, 5_000 + attempt);
        }
        throttle.resetLoginFailures(key);
        expect(throttle.recordLoginFailure(key, 6_000)).toBe(false);
    });

    it('the entry count is capped and the oldest entry is evicted', async () => {
        const throttle = await import('../../server/shared/auth/loginThrottle');
        const now = 10_000;
        for (let index = 0; index < throttle.LOGIN_THROTTLE_MAX_ENTRIES + 50; index += 1) {
            throttle.recordLoginFailure(`user-${index}@example.com`, now);
        }
        expect(throttle.getLoginThrottleSize()).toBe(throttle.LOGIN_THROTTLE_MAX_ENTRIES);
    });
});
