import { promises as fs } from 'node:fs';
import path from 'node:path';
import { prisma as db } from '../db/db';

export type AuditEventCategory = 'auth' | 'compliance' | 'ai' | 'war_room' | 'portfolio' | 'export' | 'system';

export interface AuditEventInput {
    category: AuditEventCategory;
    action: string;
    actorId: string | null;
    actorRole: string | null;
    actorName: string | null;
    teamId?: string | null;
    subject: string | null;
    outcome: 'success' | 'failure' | 'blocked';
    details?: Record<string, unknown>;
}

export interface AuditLogStatus {
    mode: 'db_primary_file_fallback';
    durable: true;
    path: string;
}

function getAuditLogPath(): string {
    return process.env.AUDIT_EVENT_LOG_PATH
        ? path.resolve(process.env.AUDIT_EVENT_LOG_PATH)
        : path.resolve(process.cwd(), 'output/audit-events.jsonl');
}

export function getAuditLogStatus(): AuditLogStatus {
    return {
        mode: 'db_primary_file_fallback',
        durable: true,
        path: getAuditLogPath(),
    };
}

async function appendAuditEventFile(input: AuditEventInput): Promise<void> {
    const filePath = getAuditLogPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const event = {
        id: `audit-event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        ...input,
    };
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

export async function appendAuditEvent(input: AuditEventInput): Promise<void> {
    try {
        await db.auditEvent.create({
            data: {
                category: input.category,
                action: input.action,
                actorId: input.actorId,
                actorRole: input.actorRole,
                actorName: input.actorName,
                teamId: input.teamId ?? null,
                subject: input.subject,
                outcome: input.outcome,
                details: input.details ? JSON.stringify(input.details) : null,
            },
        });
    } catch (error) {
        console.warn('[Audit] DB audit event write failed; falling back to file:', error instanceof Error ? error.message : error);
        if (process.env.NODE_ENV === 'test' && !process.env.AUDIT_EVENT_LOG_PATH) {
            return;
        }
        try {
            await appendAuditEventFile(input);
        } catch (fallbackError) {
            console.warn('[Audit] File audit event write failed:', fallbackError instanceof Error ? fallbackError.message : fallbackError);
        }
    }
}
