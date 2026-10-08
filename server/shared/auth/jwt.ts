import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import type { UserRole } from '../../../types';

// Issuer/audience constants are not secrets; they verify that the token belongs to this service.
export const JWT_ISSUER = 'alphapulse-api';
export const JWT_AUDIENCE = 'alphapulse-app';
const JWT_ALGORITHM = 'HS256';
const MIN_JWT_SECRET_BYTES = 32;
const ROLES: readonly UserRole[] = ['ADMIN', 'COMPLIANCE_OFFICER', 'FUND_MANAGER', 'ANALYST'];

export interface JwtUserPayload {
    id: string;
    email: string;
    role: UserRole;
    teamId?: string | null;
    teamRole?: UserRole | null;
}

export function normalizeUserRole(role: string | null | undefined): UserRole {
    if (role && (ROLES as readonly string[]).includes(role)) {
        return role as UserRole;
    }

    return 'ANALYST';
}

let ephemeralTestSecret: string | undefined;

export function getJwtSecret(): string {
    const secret = process.env.JWT_SECRET;
    if (secret) {
        if (Buffer.byteLength(secret, 'utf8') < MIN_JWT_SECRET_BYTES) {
            throw new Error(
                `JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes. Example: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
            );
        }
        return secret;
    }

    // Only when NODE_ENV=test explicitly: a random, process-private ephemeral secret (no fixed secret in the repo).
    if (process.env.NODE_ENV === 'test') {
        ephemeralTestSecret ??= randomBytes(48).toString('hex');
        return ephemeralTestSecret;
    }

    throw new Error(
        'JWT_SECRET is not set. Set a random secret of at least 32 bytes (see .env.example); there is no default secret, not even in development.'
    );
}

export function signJwt(payload: JwtUserPayload, expiresIn = '24h'): string {
    return jwt.sign(
        {
            ...payload,
            role: normalizeUserRole(payload.role),
            teamRole: payload.teamRole ? normalizeUserRole(payload.teamRole) : null,
        },
        getJwtSecret(),
        {
            algorithm: JWT_ALGORITHM,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
            expiresIn: expiresIn as SignOptions['expiresIn'],
        }
    );
}

export function verifyJwt(token: string): JwtUserPayload {
    const payload = jwt.verify(token, getJwtSecret(), {
        algorithms: [JWT_ALGORITHM],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
    }) as JwtUserPayload & { exp?: number };
    if (typeof payload.exp !== 'number') {
        throw new jwt.JsonWebTokenError('jwt exp claim is required');
    }
    return {
        ...payload,
        role: normalizeUserRole(payload.role),
        teamId: payload.teamId ?? null,
        teamRole: payload.teamRole ? normalizeUserRole(payload.teamRole) : null,
    };
}
