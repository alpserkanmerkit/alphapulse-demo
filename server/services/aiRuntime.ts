import type { AiFailureStage } from '../../types';

export type AiRouteReason =
    | 'ai_simulation'
    | 'grounding_unavailable'
    | 'quant_unavailable'
    | 'backend_timeout'
    | 'backend_error';

export class AiRouteError extends Error {
    statusCode: number;
    reason: Extract<AiRouteReason, 'backend_timeout' | 'backend_error'>;
    notice: string;
    failureStage: AiFailureStage;

    constructor(
        message: string,
        statusCode: number,
        reason: Extract<AiRouteReason, 'backend_timeout' | 'backend_error'>,
        notice: string,
        failureStage: AiFailureStage = 'unknown'
    ) {
        super(message);
        this.name = 'AiRouteError';
        this.statusCode = statusCode;
        this.reason = reason;
        this.notice = notice;
        this.failureStage = failureStage;
    }
}

export async function withAiTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    notice: string,
    failureStage: AiFailureStage = 'model'
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
        return await Promise.race([
            operation,
            new Promise<T>((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new AiRouteError(notice, 504, 'backend_timeout', notice, failureStage));
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

export function toAiRouteError(
    error: unknown,
    notice: string,
    failureStage: AiFailureStage = 'unknown'
): AiRouteError {
    if (error instanceof AiRouteError) {
        return error;
    }

    const message = error instanceof Error ? error.message : 'Unknown AI route failure';
    return new AiRouteError(message, 502, 'backend_error', notice, failureStage);
}
