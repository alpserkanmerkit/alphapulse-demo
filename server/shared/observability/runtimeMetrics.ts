export interface RuntimeMetricsSnapshot {
    startedAt: string;
    requests: {
        total: number;
        byStatusClass: Record<string, number>;
    };
    readiness: {
        total: number;
        notReady: number;
    };
    compliance: {
        unavailable: number;
        blocks: number;
    };
    quant: {
        unreachable: number;
        forecasts: Record<string, number>;
    };
    ai: {
        simulationMode: number;
        failuresByStage: Record<string, number>;
        routes: Record<string, number>;
    };
    providers: {
        calls: number;
        failures: number;
        latencyTotalMs: number;
        byProvider: Record<string, { calls: number; failures: number; latencyTotalMs: number }>;
    };
    cache: {
        hits: number;
        misses: number;
        fallbackWrites: number;
    };
    export: {
        requested: number;
        completed: number;
        failed: number;
        blocked: number;
    };
}

const metrics: RuntimeMetricsSnapshot = {
    startedAt: new Date().toISOString(),
    requests: {
        total: 0,
        byStatusClass: {},
    },
    readiness: {
        total: 0,
        notReady: 0,
    },
    compliance: {
        unavailable: 0,
        blocks: 0,
    },
    quant: {
        unreachable: 0,
        forecasts: {},
    },
    ai: {
        simulationMode: 0,
        failuresByStage: {},
        routes: {},
    },
    providers: {
        calls: 0,
        failures: 0,
        latencyTotalMs: 0,
        byProvider: {},
    },
    cache: {
        hits: 0,
        misses: 0,
        fallbackWrites: 0,
    },
    export: {
        requested: 0,
        completed: 0,
        failed: 0,
        blocked: 0,
    },
};

function increment(bucket: Record<string, number>, key: string) {
    bucket[key] = (bucket[key] ?? 0) + 1;
}

export function recordHttpRequest(statusCode: number) {
    metrics.requests.total += 1;
    increment(metrics.requests.byStatusClass, `${Math.floor(statusCode / 100)}xx`);
}

export function recordReadiness(input: {
    ready: boolean;
    complianceUnavailable: boolean;
    quantUnreachable: boolean;
    aiSimulation: boolean;
}) {
    metrics.readiness.total += 1;
    if (!input.ready) metrics.readiness.notReady += 1;
    if (input.complianceUnavailable) metrics.compliance.unavailable += 1;
    if (input.quantUnreachable) metrics.quant.unreachable += 1;
    if (input.aiSimulation) metrics.ai.simulationMode += 1;
}

export function recordComplianceBlock() {
    metrics.compliance.blocks += 1;
}

export function recordAiRoute(route: string, mode: string, failureStage: string | null = null) {
    increment(metrics.ai.routes, route);
    if (mode === 'simulation') metrics.ai.simulationMode += 1;
    if (failureStage) increment(metrics.ai.failuresByStage, failureStage);
}

export function recordQuantForecast(outcome: 'engine' | 'cache_hit' | 'fallback') {
    increment(metrics.quant.forecasts, outcome);
}

export function recordProviderCall(provider: string, durationMs: number, ok: boolean) {
    const normalizedProvider = provider || 'unknown';
    metrics.providers.calls += 1;
    metrics.providers.latencyTotalMs += Math.max(0, Math.trunc(durationMs));
    if (!ok) metrics.providers.failures += 1;

    const bucket = metrics.providers.byProvider[normalizedProvider] ?? { calls: 0, failures: 0, latencyTotalMs: 0 };
    bucket.calls += 1;
    bucket.latencyTotalMs += Math.max(0, Math.trunc(durationMs));
    if (!ok) bucket.failures += 1;
    metrics.providers.byProvider[normalizedProvider] = bucket;
}

export function recordCacheAccess(hit: boolean) {
    if (hit) metrics.cache.hits += 1;
    else metrics.cache.misses += 1;
}

export function recordCacheFallbackWrite() {
    metrics.cache.fallbackWrites += 1;
}

export function recordExportJob(outcome: 'requested' | 'completed' | 'failed' | 'blocked') {
    metrics.export[outcome] += 1;
}

export function getRuntimeMetrics(): RuntimeMetricsSnapshot {
    return {
        startedAt: metrics.startedAt,
        requests: {
            total: metrics.requests.total,
            byStatusClass: { ...metrics.requests.byStatusClass },
        },
        readiness: { ...metrics.readiness },
        compliance: { ...metrics.compliance },
        quant: {
            unreachable: metrics.quant.unreachable,
            forecasts: { ...metrics.quant.forecasts },
        },
        ai: {
            simulationMode: metrics.ai.simulationMode,
            failuresByStage: { ...metrics.ai.failuresByStage },
            routes: { ...metrics.ai.routes },
        },
        providers: {
            calls: metrics.providers.calls,
            failures: metrics.providers.failures,
            latencyTotalMs: metrics.providers.latencyTotalMs,
            byProvider: Object.fromEntries(
                Object.entries(metrics.providers.byProvider).map(([provider, bucket]) => [provider, { ...bucket }])
            ),
        },
        cache: { ...metrics.cache },
        export: { ...metrics.export },
    };
}

export function resetRuntimeMetricsForTests() {
    metrics.requests.total = 0;
    metrics.requests.byStatusClass = {};
    metrics.readiness.total = 0;
    metrics.readiness.notReady = 0;
    metrics.compliance.unavailable = 0;
    metrics.compliance.blocks = 0;
    metrics.quant.unreachable = 0;
    metrics.quant.forecasts = {};
    metrics.ai.simulationMode = 0;
    metrics.ai.failuresByStage = {};
    metrics.ai.routes = {};
    metrics.providers.calls = 0;
    metrics.providers.failures = 0;
    metrics.providers.latencyTotalMs = 0;
    metrics.providers.byProvider = {};
    metrics.cache.hits = 0;
    metrics.cache.misses = 0;
    metrics.cache.fallbackWrites = 0;
    metrics.export.requested = 0;
    metrics.export.completed = 0;
    metrics.export.failed = 0;
    metrics.export.blocked = 0;
}
