import { createHash } from 'node:crypto';
import { prisma as db } from '../db/db';

export interface ModelRunInput {
    teamId?: string | null;
    actorId?: string | null;
    route: string;
    modelFamily: string;
    modelName?: string | null;
    promptVersion?: string | null;
    input: unknown;
    mode: string;
    outcome: 'success' | 'failure' | 'fallback' | 'cache_hit';
    failureStage?: string | null;
    durationMs?: number;
    sourceCount?: number;
}

export function hashModelInput(input: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(input ?? null))
        .digest('hex')
        .slice(0, 24);
}

let modelRunStoreUnavailable = false;

function isModelRunStoreUnavailable(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes('no such table') ||
        message.includes('no such column') ||
        message.includes('P2021') ||
        message.includes('P2022') ||
        message.includes('SQLITE_ERROR')
    );
}

export async function recordModelRun(input: ModelRunInput): Promise<string | null> {
    if (modelRunStoreUnavailable) {
        return null;
    }

    try {
        const modelRun = await db.modelRun.create({
            data: {
                teamId: input.teamId ?? null,
                actorId: input.actorId ?? null,
                route: input.route,
                modelFamily: input.modelFamily,
                modelName: input.modelName ?? null,
                promptVersion: input.promptVersion ?? null,
                inputHash: hashModelInput(input.input),
                mode: input.mode,
                outcome: input.outcome,
                failureStage: input.failureStage ?? null,
                durationMs: Number.isFinite(input.durationMs) ? Math.trunc(input.durationMs ?? 0) : null,
                sourceCount: Math.max(0, Math.trunc(input.sourceCount ?? 0)),
            },
        });
        return modelRun.id;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isModelRunStoreUnavailable(error)) {
            modelRunStoreUnavailable = true;
        } else {
            console.warn('[ModelRun] Ledger write failed:', message);
        }
        return null;
    }
}
