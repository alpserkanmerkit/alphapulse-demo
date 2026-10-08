import { randomBytes } from 'node:crypto';
import { afterEach, vi } from 'vitest';

// No fixed JWT secret in the repo: every test process generates its own random secret (F-1).
process.env.JWT_SECRET ??= randomBytes(48).toString('hex');

afterEach(() => {
    vi.restoreAllMocks();
});
