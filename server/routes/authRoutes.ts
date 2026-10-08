import { Router, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma as db } from '../shared/db/db';
import { normalizeUserRole, signJwt } from '../shared/auth/jwt';
import { buildTeamJwtPayload, ensureDefaultTeamForUser } from '../shared/auth/teamContext';
import type { TeamContext } from '../shared/auth/teamContext';
import { appendAuditEvent } from '../shared/audit/auditLog';
import { getLoginLockRemainingMs, recordLoginFailure, resetLoginFailures } from '../shared/auth/loginThrottle';

const router = Router();

const authSchema = z.object({
    email: z.string().trim().email().transform((email) => email.toLowerCase()),
    // Upper bound: bcrypt truncates after 72 bytes and very long input is a CPU/DoS surface (ASVS 2.1.2).
    password: z.string().min(8).max(128),
});

const registerSchema = authSchema.extend({
    name: z.string().trim().max(80).optional(),
});

const AUTH_BCRYPT_ROUNDS = 10;

// Dummy hash so bcrypt.compare still runs when the user does not exist
// (timing equalization). Generated at runtime; it is nobody's password.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
    dummyHashPromise ??= bcrypt.hash(randomBytes(16).toString('hex'), AUTH_BCRYPT_ROUNDS);
    return dummyHashPromise;
}

void getDummyHash(); // Pre-warm so the first request shows no latency difference.

function publicUser(user: { id: string; email: string; name: string | null; role: string }, teamContext?: TeamContext) {
    return {
        id: user.id,
        email: user.email,
        name: user.name ?? '',
        role: normalizeUserRole(user.role),
        ...(teamContext ? { teamContext } : {}),
    };
}

// To prevent account enumeration the response is identical whether or not the email
// is already registered (202, no token). After registering, the client calls /login with the same credentials.
const REGISTER_ACCEPTED_BODY = { success: true, message: 'Registration received' } as const;

router.post('/register', async (req: Request, res: Response) => {
    try {
        const parsed = registerSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ success: false, error: 'Valid email and password (8-128 characters) required' });
        }

        const { email, password, name } = parsed.data;
        // The hash is always computed so existing and new emails show no timing difference.
        const hashedPassword = await bcrypt.hash(password, AUTH_BCRYPT_ROUNDS);
        const existing = await db.user.findUnique({ where: { email } });
        let created: { id: string; email: string; role: string } | null = null;
        if (!existing) {
            try {
                created = await db.user.create({
                    data: { email, password: hashedPassword, name },
                });
            } catch (createError) {
                // Concurrent registration race (unique constraint): treated like an existing account.
                if ((createError as { code?: string }).code !== 'P2002') throw createError;
            }
        }

        if (created) {
            const role = normalizeUserRole(created.role);
            const team = await ensureDefaultTeamForUser({ id: created.id, email: created.email, role });
            await appendAuditEvent({
                category: 'auth',
                action: 'Registered User',
                actorId: created.id,
                actorRole: role,
                actorName: created.email,
                teamId: team.teamId,
                subject: created.email,
                outcome: 'success',
            });
        } else {
            await appendAuditEvent({
                category: 'auth',
                action: 'Register Duplicate Email',
                actorId: null,
                actorRole: null,
                actorName: null,
                subject: email,
                outcome: 'blocked',
            });
        }

        res.status(202).json(REGISTER_ACCEPTED_BODY);
    } catch (error) {
        console.error('[Auth] Register error:', error);
        res.status(500).json({ success: false, error: 'Registration failed. Check database setup.' });
    }
});

router.post('/login', async (req: Request, res: Response) => {
    try {
        const parsed = authSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ success: false, error: 'Valid email and password (8-128 characters) required' });
        }

        const { email, password } = parsed.data;

        // Account lock (keyed only on email, without distinguishing existing/missing users).
        const lockRemainingMs = getLoginLockRemainingMs(email);
        if (lockRemainingMs > 0) {
            await appendAuditEvent({
                category: 'auth',
                action: 'Login Blocked',
                actorId: null,
                actorRole: null,
                actorName: null,
                subject: email,
                outcome: 'blocked',
                details: { reason: 'account_locked' },
            });
            res.set('Retry-After', String(Math.ceil(lockRemainingMs / 1000)));
            return res.status(429).json({ success: false, error: 'Too many failed attempts. Try again later.' });
        }

        const user = await db.user.findUnique({ where: { email } });
        // bcrypt.compare runs even when the user does not exist (timing equalization).
        const passwordMatches = await bcrypt.compare(password, user?.password ?? await getDummyHash());
        if (!user || !passwordMatches) {
            const lockedNow = recordLoginFailure(email);
            await appendAuditEvent({
                category: 'auth',
                action: 'Login Failed',
                actorId: user?.id ?? null,
                actorRole: null,
                actorName: null,
                subject: email,
                outcome: 'failure',
                details: { reason: 'invalid_credentials', lockedNow },
            });
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }
        resetLoginFailures(email);

        const role = normalizeUserRole(user.role);
        const team = await ensureDefaultTeamForUser({ id: user.id, email: user.email, role });
        await appendAuditEvent({
            category: 'auth',
            action: 'Logged In',
            actorId: user.id,
            actorRole: role,
            actorName: user.email,
            teamId: team.teamId,
            subject: user.email,
            outcome: 'success',
        });

        const token = signJwt(buildTeamJwtPayload({ id: user.id, email: user.email, role }, team));
        res.json({ success: true, token, user: publicUser(user, team) });
    } catch (error) {
        console.error('[Auth] Login error:', error);
        res.status(500).json({ success: false, error: 'Login failed. Check database setup.' });
    }
});

export default router;
