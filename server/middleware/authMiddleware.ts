import { Request, Response, NextFunction } from 'express';
import { JwtUserPayload, verifyJwt } from '../shared/auth/jwt';
import type { UserRole } from '../../types';
import { resolveActiveTeamContext, type TeamContext } from '../shared/auth/teamContext';
import { prisma as db } from '../shared/db/db';

export interface AuthRequest extends Request {
    user?: JwtUserPayload;
    teamContext?: TeamContext;
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
    }

    const token = authHeader.split(' ')[1];
    try {
        req.user = verifyJwt(token);
        next();
    } catch {
        return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
    }
};

export const requireRole = (...allowedRoles: UserRole[]) => (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized: No authenticated user' });
    }

    const effectiveRole = req.teamContext?.role ?? req.user.teamRole ?? req.user.role;
    if (!allowedRoles.includes(effectiveRole)) {
        return res.status(403).json({
            success: false,
            error: 'Forbidden: Insufficient role',
            requiredRoles: allowedRoles,
            role: effectiveRole,
        });
    }

    next();
};

export const requireTeamContext = async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized: No authenticated user' });
    }

    try {
        const team = await resolveActiveTeamContext(req.user);
        req.teamContext = team;
        req.user.teamId = team.teamId;
        req.user.teamRole = team.role;
        next();
    } catch (error) {
        if (error instanceof Error && error.message === 'TEAM_MEMBERSHIP_REQUIRED') {
            const existingUser = await db.user.findUnique({ where: { id: req.user.id }, select: { id: true } }).catch(() => null);
            if (!existingUser) {
                return res.status(401).json({ success: false, error: 'Unauthorized: User no longer exists' });
            }
            return res.status(403).json({ success: false, error: 'Forbidden: Team membership required' });
        }

        console.error('[Auth] Team context unavailable:', error);
        return res.status(500).json({ success: false, error: 'Failed to resolve team context' });
    }
};

export const optionalTeamContext = async (req: AuthRequest, _res: Response, next: NextFunction) => {
    if (!req.user) {
        next();
        return;
    }

    try {
        const team = await resolveActiveTeamContext(req.user);
        req.teamContext = team;
        req.user.teamId = team.teamId;
        req.user.teamRole = team.role;
    } catch {
        req.teamContext = undefined;
        req.user.teamId = null;
        req.user.teamRole = null;
    }
    next();
};

export const optionalAuth = (req: AuthRequest, _res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            req.user = verifyJwt(token);
        } catch {
            // Optional auth deliberately ignores invalid tokens.
        }
    }
    next();
};
