import { randomUUID } from 'node:crypto';
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma as db } from '../shared/db/db';
import { AuthRequest, requireAuth } from '../middleware/authMiddleware';
import { buildTeamJwtPayload, ensureDefaultTeamForUser, getTeamContextForUser, listTeamContextsForUser } from '../shared/auth/teamContext';
import { normalizeUserRole, signJwt } from '../shared/auth/jwt';
import type { UserRole } from '../../types';

const router = Router();

const ROLES: UserRole[] = ['ADMIN', 'COMPLIANCE_OFFICER', 'FUND_MANAGER', 'ANALYST'];
const teamSchema = z.object({
    name: z.string().trim().min(2).max(80),
    slug: z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/i).optional(),
});
const memberSchema = z.object({
    email: z.string().trim().email().transform((email) => email.toLowerCase()),
    role: z.enum(ROLES as [UserRole, ...UserRole[]]),
});
const roleSchema = z.object({
    role: z.enum(ROLES as [UserRole, ...UserRole[]]),
});

function slugify(input: string): string {
    const slug = input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
    return slug || `team-${randomUUID().slice(0, 8)}`;
}

async function assertTeamAdmin(teamId: string, userId: string): Promise<void> {
    const membership = await db.teamMembership.findFirst({ where: { teamId, userId } });
    if (!membership || normalizeUserRole(membership.role) !== 'ADMIN') {
        throw new Error('TEAM_ADMIN_REQUIRED');
    }
}

async function adminCount(teamId: string): Promise<number> {
    return db.teamMembership.count({ where: { teamId, role: 'ADMIN' } });
}

async function teamResponseForUser(user: { id: string; email: string; role: string }, teamId: string) {
    const teamContext = await getTeamContextForUser(user.id, teamId);
    const token = signJwt(buildTeamJwtPayload(user, teamContext));
    return {
        token,
        teamContext,
        user: {
            id: user.id,
            email: user.email,
            role: normalizeUserRole(user.role),
            teamContext,
        },
    };
}

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
        const user = await db.user.findUnique({ where: { id: req.user!.id } });
        if (!user) return res.status(401).json({ success: false, error: 'Unauthorized: User no longer exists' });

        let teams = await listTeamContextsForUser(user.id);
        if (teams.length === 0) {
            await ensureDefaultTeamForUser({ id: user.id, email: user.email, role: user.role });
            teams = await listTeamContextsForUser(user.id);
        }

        res.json({ success: true, teams, activeTeamId: req.user!.teamId ?? teams[0]?.teamId ?? null });
    } catch (error) {
        console.error('[Teams] List failed:', error);
        res.status(500).json({ success: false, error: 'Failed to list teams' });
    }
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
    const parsed = teamSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid team parameters' });

    try {
        const user = await db.user.findUnique({ where: { id: req.user!.id } });
        if (!user) return res.status(401).json({ success: false, error: 'Unauthorized: User no longer exists' });

        const baseSlug = parsed.data.slug ? slugify(parsed.data.slug) : slugify(parsed.data.name);
        const slug = `${baseSlug}-${randomUUID().slice(0, 8)}`;
        const team = await db.team.create({
            data: {
                name: parsed.data.name,
                slug,
                memberships: {
                    create: {
                        userId: user.id,
                        role: 'ADMIN',
                    },
                },
            },
        });

        res.status(201).json({ success: true, team, ...(await teamResponseForUser(user, team.id)) });
    } catch (error) {
        console.error('[Teams] Create failed:', error);
        res.status(500).json({ success: false, error: 'Failed to create team' });
    }
});

router.post('/:id/switch', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
        const user = await db.user.findUnique({ where: { id: req.user!.id } });
        if (!user) return res.status(401).json({ success: false, error: 'Unauthorized: User no longer exists' });

        const payload = await teamResponseForUser(user, String(req.params.id));
        res.json({ success: true, ...payload });
    } catch (error) {
        if (error instanceof Error && error.message === 'TEAM_MEMBERSHIP_REQUIRED') {
            return res.status(403).json({ success: false, error: 'Forbidden: Team membership required' });
        }
        console.error('[Teams] Switch failed:', error);
        res.status(500).json({ success: false, error: 'Failed to switch team' });
    }
});

router.get('/:id/members', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
        await assertTeamAdmin(String(req.params.id), req.user!.id);
        const members = await db.teamMembership.findMany({
            where: { teamId: String(req.params.id) },
            include: { user: { select: { id: true, email: true, name: true, role: true } } },
            orderBy: { createdAt: 'asc' },
        });
        res.json({
            success: true,
            members: members.map((member) => ({
                id: member.id,
                userId: member.userId,
                email: member.user.email,
                name: member.user.name ?? '',
                role: normalizeUserRole(member.role),
                createdAt: member.createdAt,
            })),
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'TEAM_ADMIN_REQUIRED') {
            return res.status(403).json({ success: false, error: 'Forbidden: Team admin role required' });
        }
        console.error('[Teams] Members list failed:', error);
        res.status(500).json({ success: false, error: 'Failed to list team members' });
    }
});

router.post('/:id/members', requireAuth, async (req: AuthRequest, res: Response) => {
    const parsed = memberSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid member parameters' });

    try {
        const teamId = String(req.params.id);
        await assertTeamAdmin(teamId, req.user!.id);
        const user = await db.user.findUnique({ where: { email: parsed.data.email } });
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const membership = await db.teamMembership.upsert({
            where: { teamId_userId: { teamId, userId: user.id } },
            create: { teamId, userId: user.id, role: parsed.data.role },
            update: { role: parsed.data.role },
        });
        res.status(201).json({ success: true, membership });
    } catch (error) {
        if (error instanceof Error && error.message === 'TEAM_ADMIN_REQUIRED') {
            return res.status(403).json({ success: false, error: 'Forbidden: Team admin role required' });
        }
        console.error('[Teams] Member add failed:', error);
        res.status(500).json({ success: false, error: 'Failed to add team member' });
    }
});

router.patch('/:id/members/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
    const parsed = roleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid member role' });

    try {
        const teamId = String(req.params.id);
        const userId = String(req.params.userId);
        await assertTeamAdmin(teamId, req.user!.id);
        const current = await db.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId } } });
        if (!current) return res.status(404).json({ success: false, error: 'Team member not found' });
        if (normalizeUserRole(current.role) === 'ADMIN' && parsed.data.role !== 'ADMIN' && await adminCount(teamId) <= 1) {
            return res.status(409).json({ success: false, error: 'Cannot remove the last team admin' });
        }

        const membership = await db.teamMembership.update({
            where: { teamId_userId: { teamId, userId } },
            data: { role: parsed.data.role },
        });
        res.json({ success: true, membership });
    } catch (error) {
        if (error instanceof Error && error.message === 'TEAM_ADMIN_REQUIRED') {
            return res.status(403).json({ success: false, error: 'Forbidden: Team admin role required' });
        }
        console.error('[Teams] Member update failed:', error);
        res.status(500).json({ success: false, error: 'Failed to update team member' });
    }
});

router.delete('/:id/members/:userId', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
        const teamId = String(req.params.id);
        const userId = String(req.params.userId);
        await assertTeamAdmin(teamId, req.user!.id);
        const current = await db.teamMembership.findUnique({ where: { teamId_userId: { teamId, userId } } });
        if (!current) return res.status(404).json({ success: false, error: 'Team member not found' });
        if (normalizeUserRole(current.role) === 'ADMIN' && await adminCount(teamId) <= 1) {
            return res.status(409).json({ success: false, error: 'Cannot remove the last team admin' });
        }

        await db.teamMembership.delete({ where: { teamId_userId: { teamId, userId } } });
        res.json({ success: true });
    } catch (error) {
        if (error instanceof Error && error.message === 'TEAM_ADMIN_REQUIRED') {
            return res.status(403).json({ success: false, error: 'Forbidden: Team admin role required' });
        }
        console.error('[Teams] Member remove failed:', error);
        res.status(500).json({ success: false, error: 'Failed to remove team member' });
    }
});

export default router;
