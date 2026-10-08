import { QuantDiagnosticReason } from '../../types';

const QUANT_ENGINE_URL = process.env.QUANT_ENGINE_URL || 'http://127.0.0.1:8000';
const DEFAULT_QUANT_FORECAST_TIMEOUT_MS = 25000;

export interface QuantHealthCheckResult {
    status: 'reachable' | 'unreachable';
    reason: QuantDiagnosticReason | null;
    checkedAt: string;
}

interface QuantRequestSuccess<T> {
    ok: true;
    data: T;
    reason: null;
}

interface QuantRequestFailure {
    ok: false;
    data: null;
    reason: QuantDiagnosticReason;
    statusCode?: number;
}

export type QuantRequestResult<T> = QuantRequestSuccess<T> | QuantRequestFailure;

export interface QuantRequestOptions {
    timeoutMs?: number;
    signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

function inferConnectionRefused(error: unknown): boolean {
    return error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause && error.cause.code === 'ECONNREFUSED';
}

export function classifyQuantError(error: unknown): QuantDiagnosticReason {
    if (isAbortError(error)) return 'timeout';
    if (inferConnectionRefused(error)) return 'connection_refused';
    return 'unknown';
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let removeAbortListener: (() => void) | null = null;

    if (signal) {
        if (signal.aborted) {
            controller.abort();
        } else {
            const abortFromParent = () => controller.abort();
            signal.addEventListener('abort', abortFromParent, { once: true });
            removeAbortListener = () => signal.removeEventListener('abort', abortFromParent);
        }
    }

    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeoutId);
        removeAbortListener?.();
    }
}

function normalizeRequestOptions(timeoutOrOptions?: number | QuantRequestOptions): Required<Pick<QuantRequestOptions, 'timeoutMs'>> & Pick<QuantRequestOptions, 'signal'> {
    if (typeof timeoutOrOptions === 'number') {
        return { timeoutMs: timeoutOrOptions };
    }

    return {
        timeoutMs: timeoutOrOptions?.timeoutMs ?? DEFAULT_QUANT_FORECAST_TIMEOUT_MS,
        signal: timeoutOrOptions?.signal,
    };
}

function isValidHealthPayload(payload: unknown): payload is { status: string; service: string } {
    return Boolean(
        payload &&
        typeof payload === 'object' &&
        'status' in payload &&
        'service' in payload &&
        (payload as { status: string }).status === 'ok' &&
        (payload as { service: string }).service === 'quant-engine'
    );
}

export async function checkQuantHealth(): Promise<QuantHealthCheckResult> {
    const checkedAt = new Date().toISOString();

    try {
        const response = await fetchWithTimeout(`${QUANT_ENGINE_URL}/health`, {}, 1500);

        if (!response.ok) {
            return { status: 'unreachable', reason: 'http_error', checkedAt };
        }

        const payload = await response.json().catch(() => null);
        if (!isValidHealthPayload(payload)) {
            return { status: 'unreachable', reason: 'invalid_payload', checkedAt };
        }

        return { status: 'reachable', reason: null, checkedAt };
    } catch (error) {
        return { status: 'unreachable', reason: classifyQuantError(error), checkedAt };
    }
}

export async function requestQuantForecast<T = unknown>(
    horizon: 'short-term' | 'medium-term' | 'long-term',
    body: Record<string, unknown>,
    timeoutOrOptions: number | QuantRequestOptions = DEFAULT_QUANT_FORECAST_TIMEOUT_MS
): Promise<QuantRequestResult<T>> {
    const { timeoutMs, signal } = normalizeRequestOptions(timeoutOrOptions);

    try {
        const response = await fetchWithTimeout(
            `${QUANT_ENGINE_URL}/api/forecast/${horizon}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
            timeoutMs,
            signal
        );

        if (!response.ok) {
            return { ok: false, data: null, reason: 'http_error', statusCode: response.status };
        }

        const payload = await response.json().catch(() => null);
        if (!payload || typeof payload !== 'object') {
            return { ok: false, data: null, reason: 'invalid_payload' };
        }

        return { ok: true, data: payload as T, reason: null };
    } catch (error) {
        return { ok: false, data: null, reason: classifyQuantError(error) };
    }
}
