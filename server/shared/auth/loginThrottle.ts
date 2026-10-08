// Per-account login lockout (F-2, ASVS 2.2.1).
//
// Key: the normalized email. The same counter is updated whether or not the
// account exists, so lockout behaviour does not leak whether a user exists.
//
// RESIDUAL RISK (deliberate limitation): state lives in process memory. In a
// multi-instance (horizontally scaled) deployment each instance keeps its own
// counter, so the effective threshold is multiplied by the instance count and a
// restart resets the counter. A durable/shared counter (Redis or a Prisma
// table) should be planned as separate work.
// Also, once the 10k-entry cap is full, an attacker can use many different
// emails to evict older entries (including the victim's counter); the IP-based
// global rate limiter (F-3) narrows this path.

export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_THROTTLE_MAX_ENTRIES = 10_000;

interface ThrottleEntry {
    failures: number;
    lastFailureAt: number;
    lockedUntil: number;
}

// Map preserves insertion order: the oldest entry is the first key.
const entries = new Map<string, ThrottleEntry>();

function isExpired(entry: ThrottleEntry, now: number): boolean {
    return now >= entry.lockedUntil && now - entry.lastFailureAt >= LOGIN_LOCK_WINDOW_MS;
}

/** Remaining lock time (ms) if locked, otherwise 0. */
export function getLoginLockRemainingMs(key: string, now: number = Date.now()): number {
    const entry = entries.get(key);
    if (!entry) return 0;
    if (isExpired(entry, now)) {
        entries.delete(key);
        return 0;
    }
    return Math.max(0, entry.lockedUntil - now);
}

/** Records a failed attempt; starts the lock once the threshold is reached. true = locked just now. */
export function recordLoginFailure(key: string, now: number = Date.now()): boolean {
    let entry = entries.get(key);
    if (entry && isExpired(entry, now)) {
        entries.delete(key);
        entry = undefined;
    }

    const next: ThrottleEntry = {
        failures: (entry?.failures ?? 0) + 1,
        lastFailureAt: now,
        lockedUntil: entry?.lockedUntil ?? 0,
    };
    let locked = false;
    if (next.failures >= LOGIN_MAX_FAILURES && now >= next.lockedUntil) {
        next.lockedUntil = now + LOGIN_LOCK_WINDOW_MS;
        locked = true;
    }

    // Re-insert so the newest entry moves to the end.
    entries.delete(key);
    entries.set(key, next);
    while (entries.size > LOGIN_THROTTLE_MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
    }
    return locked;
}

export function resetLoginFailures(key: string): void {
    entries.delete(key);
}

export function getLoginThrottleSize(): number {
    return entries.size;
}
