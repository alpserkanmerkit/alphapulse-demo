import { ComplianceServiceStatus, DataMode, QuantDiagnosticReason, RuntimeStatusResponse, RuntimeViewState } from '../types';

const QUANT_REASON_LABELS: Record<QuantDiagnosticReason, string> = {
    connection_refused: 'connection refused',
    timeout: 'timeout',
    http_error: 'http error',
    invalid_payload: 'invalid payload',
    unknown: 'unknown error',
};

export function formatQuantDiagnosticReason(reason: QuantDiagnosticReason | null): string | null {
    return reason ? QUANT_REASON_LABELS[reason] : null;
}

export function buildRuntimeView(
    runtimeStatus: RuntimeStatusResponse | null,
    feedMode: DataMode,
    analysisMode: DataMode,
    analysisNotice?: string | null
): RuntimeViewState {
    const backendLive = Boolean(runtimeStatus);
    const aiMode: DataMode = backendLive ? runtimeStatus?.services.ai ?? 'simulation' : analysisMode;
    const quantStatus = runtimeStatus?.services.quant ?? 'unreachable';
    const quantReason = runtimeStatus?.diagnostics.quant.reason ?? null;
    const complianceStatus: ComplianceServiceStatus = backendLive
        ? runtimeStatus?.services.compliance ?? 'unavailable'
        : 'unavailable';
    const complianceSource = runtimeStatus?.diagnostics.compliance.source ?? null;

    const analysisLabel = analysisMode === 'fallback'
        ? analysisNotice ?? 'Analysis is using local fallback output.'
        : null;
    const simulationLabel = aiMode === 'simulation'
        ? 'AI is running in simulation mode.'
        : null;

    const notices = Array.from(
        new Set(
            [
                !backendLive ? 'Live services are temporarily offline.' : null,
                simulationLabel,
                feedMode === 'fallback' ? 'Feed is using local fallback data.' : null,
                analysisLabel,
                complianceStatus === 'degraded' ? 'Compliance coverage is available with limited data.' : null,
                complianceStatus === 'unavailable' ? 'Compliance coverage is temporarily unavailable.' : null,
            ].filter(Boolean) as string[]
        )
    );

    const diagnostics = Array.from(
        new Set(
            [
                !backendLive ? 'Backend unreachable' : null,
                aiMode === 'simulation' ? 'AI simulation mode' : null,
                analysisMode === 'fallback' ? analysisNotice ?? 'Local analysis fallback' : null,
                feedMode === 'fallback' ? 'Feed fallback active' : null,
                quantStatus === 'unreachable'
                    ? `Quant unavailable${formatQuantDiagnosticReason(quantReason) ? ` (${formatQuantDiagnosticReason(quantReason)})` : ''}`
                    : 'Quant reachable',
                complianceSource ? `Compliance source ${complianceSource}` : null,
                complianceStatus !== 'ready' ? `Compliance ${complianceStatus}` : null,
            ].filter(Boolean) as string[]
        )
    );

    return {
        backendLive,
        aiMode,
        quantStatus,
        quantReason,
        complianceStatus,
        complianceSource,
        feedMode,
        analysisMode,
        notices,
        diagnostics,
        labels: {
            backend: backendLive ? 'Online' : 'Offline',
            ai: aiMode === 'live' ? 'Live AI' : 'Simulation',
            feed: feedMode === 'live' ? 'Live Feed' : 'Fallback Feed',
            quant: quantStatus === 'reachable' ? 'Price Model Ready' : 'Price Model Standby',
            compliance: complianceStatus === 'ready'
                ? 'Dataset Active'
                : complianceStatus === 'degraded'
                    ? 'Dataset Limited'
                    : 'Dataset Offline',
        },
    };
}
