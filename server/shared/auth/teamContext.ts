import { prisma as db } from '../db/db';
import { normalizeUserRole, type JwtUserPayload } from './jwt';
import type { UserRole } from '../../../types';

export const INSTITUTIONAL_TEAM_SLUG = 'compliance-default';
export const INSTITUTIONAL_TEAM_NAME = 'AlphaPulse Compliance';

export interface TeamContext {
    teamId: string;
    teamName: string;
    role: UserRole;
}

export async function ensureInstitutionalTeam() {
    return db.team.upsert({
        where: { slug: INSTITUTIONAL_TEAM_SLUG },
        create: {
            name: INSTITUTIONAL_TEAM_NAME,
            slug: INSTITUTIONAL_TEAM_SLUG,
        },
        update: {
            name: INSTITUTIONAL_TEAM_NAME,
        },
    });
}

export async function ensureDefaultTeamForUser(user: { id: string; email: string; role: string }): Promise<TeamContext> {
    void user.email;
    const team = await ensureInstitutionalTeam();
    const existingMembership = await db.teamMembership.findUnique({
        where: {
            teamId_userId: {
                teamId: team.id,
                userId: user.id,
            },
        },
    });
    const membership = existingMembership ?? await db.teamMembership.create({
        data: {
            teamId: team.id,
            userId: user.id,
            role: normalizeUserRole(user.role),
        },
    });

    return {
        teamId: team.id,
        teamName: team.name,
        role: normalizeUserRole(membership.role),
    };
}

export async function getTeamContextForUser(userId: string, requestedTeamId?: string | null): Promise<TeamContext> {
    const membership = requestedTeamId
        ? await db.teamMembership.findFirst({
            where: { userId, teamId: requestedTeamId },
            include: { team: true },
        })
        : await db.teamMembership.findFirst({
            where: { userId },
            include: { team: true },
            orderBy: { createdAt: 'asc' },
        });

    if (!membership) {
        throw new Error('TEAM_MEMBERSHIP_REQUIRED');
    }

    return {
        teamId: membership.teamId,
        teamName: membership.team.name,
        role: normalizeUserRole(membership.role),
    };
}

export async function resolveActiveTeamContext(user: JwtUserPayload): Promise<TeamContext> {
    try {
        return await getTeamContextForUser(user.id, user.teamId ?? null);
    } catch (error) {
        if (user.teamId || !(error instanceof Error) || error.message !== 'TEAM_MEMBERSHIP_REQUIRED') {
            throw error;
        }

        return ensureDefaultTeamForUser({ id: user.id, email: user.email, role: user.role });
    }
}

export async function listTeamContextsForUser(userId: string): Promise<TeamContext[]> {
    const memberships = await db.teamMembership.findMany({
        where: { userId },
        include: { team: true },
        orderBy: [{ createdAt: 'asc' }],
    });

    return memberships.map((membership) => ({
        teamId: membership.teamId,
        teamName: membership.team.name,
        role: normalizeUserRole(membership.role),
    }));
}

export function buildTeamJwtPayload(user: { id: string; email: string; role: string }, team: TeamContext): JwtUserPayload {
    return {
        id: user.id,
        email: user.email,
        role: normalizeUserRole(user.role),
        teamId: team.teamId,
        teamRole: team.role,
    };
}
