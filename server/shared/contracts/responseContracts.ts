import type { DataMode, DataQuality, Provenance, Telemetry } from '../../../types';

type QualityStatus = DataQuality['status'];

export function buildProvenance(input: {
    provider: string;
    mode: DataMode;
    sourceType: Provenance['sourceType'];
    fetchedAt?: string;
    fromCache?: boolean;
    degradationReason?: string | null;
}): Provenance {
    return {
        provider: input.provider,
        fetchedAt: input.fetchedAt ?? new Date().toISOString(),
        mode: input.mode,
        sourceType: input.sourceType,
        fromCache: input.fromCache ?? false,
        degradationReason: input.degradationReason ?? null,
    };
}

export function buildDataQuality(input: {
    status: QualityStatus;
    freshness?: DataQuality['freshness'];
    observations?: number;
    missingSymbols?: string[];
    errors?: Record<string, string>;
}): DataQuality {
    return {
        status: input.status,
        freshness: input.freshness ?? null,
        observations: input.observations ?? 0,
        missingSymbols: input.missingSymbols ?? [],
        errors: input.errors ?? {},
    };
}

export function buildTelemetry(input: Telemetry = {}): Telemetry {
    return {
        requestId: input.requestId ?? null,
        durationMs: input.durationMs,
        failureStage: input.failureStage ?? null,
    };
}
