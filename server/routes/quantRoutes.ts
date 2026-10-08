import { Router, Response } from 'express';
import { getQuantForecastWithFallback } from '../services/quantForecastService';
import { cacheManager } from '../shared/cache/cacheManager';
import { buildDataQuality, buildProvenance, buildTelemetry } from '../shared/contracts/responseContracts';
import { getQuantModelGovernance } from '../shared/contracts/modelGovernance';
import { appendAuditEvent } from '../shared/audit/auditLog';
import { AuthRequest, requireAuth, requireTeamContext } from '../middleware/authMiddleware';
import { complianceMiddleware } from '../middleware/complianceCheck';
import { recordModelRun } from '../shared/modelRun/modelRunLedger';
import { recordQuantForecast } from '../shared/observability/runtimeMetrics';

const router = Router();

router.post('/:horizon', requireAuth, requireTeamContext, complianceMiddleware, async (req: AuthRequest, res: Response) => {
    const horizon = req.params.horizon as string;
    const { ticker, sentiment_score, current_price, risk_free_rate } = req.body;

    if (!['short-term', 'medium-term', 'long-term'].includes(horizon)) {
        return res.status(400).json({ success: false, error: 'Invalid horizon' });
    }

    if (!ticker) {
        return res.status(400).json({ success: false, error: 'ticker required' });
    }

    const normalizedHorizon = horizon as 'short-term' | 'medium-term' | 'long-term';
    const normalizedTicker = String(ticker).trim().toUpperCase();
    const cacheKey = `quant:${normalizedHorizon}:${normalizedTicker}:${sentiment_score ?? 'na'}:${current_price ?? 'na'}:${risk_free_rate ?? 'na'}`;

    try {
        const cached = await cacheManager.get(cacheKey);
        if (cached) {
            recordQuantForecast('cache_hit');
            const modelRunId = await recordModelRun({
                teamId: req.teamContext?.teamId ?? null,
                actorId: req.user?.id ?? null,
                route: `/api/quant/${normalizedHorizon}`,
                modelFamily: 'quant_forecast',
                modelName: normalizedHorizon,
                promptVersion: 'quant-route-v1',
                input: { normalizedHorizon, normalizedTicker, sentiment_score, current_price, risk_free_rate },
                mode: 'live',
                outcome: 'cache_hit',
                durationMs: req.startedAt ? Date.now() - req.startedAt : undefined,
                sourceCount: 1,
            });
            await appendAuditEvent({
                category: 'system',
                action: 'Quant Forecast Served From Cache',
                actorId: null,
                actorRole: null,
                actorName: null,
                teamId: null,
                subject: normalizedTicker,
                outcome: 'success',
                details: { horizon: normalizedHorizon, requestId: req.requestId ?? null },
            });
            return res.json({
                success: true,
                isFallback: false,
                fromCache: true,
                ...JSON.parse(cached),
                modelGovernance: getQuantModelGovernance(normalizedHorizon, false),
                provenance: buildProvenance({ provider: 'Quant Engine', mode: 'live', sourceType: 'quant', fromCache: true }),
                dataQuality: buildDataQuality({ status: 'ready', observations: 1 }),
                telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
                modelRunId,
            });
        }
    } catch {
        // Cache is optional; continue to quant engine/fallback.
    }

    const forecast = await getQuantForecastWithFallback(normalizedHorizon, normalizedTicker, {
        sentiment_score,
        current_price,
        risk_free_rate,
    });

    if (!forecast.isFallback) {
        await cacheManager.set(cacheKey, JSON.stringify(forecast.payload), 6 * 60 * 60);
        recordQuantForecast('engine');
        const modelRunId = await recordModelRun({
            teamId: req.teamContext?.teamId ?? null,
            actorId: req.user?.id ?? null,
            route: `/api/quant/${normalizedHorizon}`,
            modelFamily: 'quant_forecast',
            modelName: normalizedHorizon,
            promptVersion: 'quant-route-v1',
            input: { normalizedHorizon, normalizedTicker, sentiment_score, current_price, risk_free_rate },
            mode: 'live',
            outcome: 'success',
            durationMs: req.startedAt ? Date.now() - req.startedAt : undefined,
            sourceCount: 1,
        });
        await appendAuditEvent({
            category: 'system',
            action: 'Quant Forecast Served From Engine',
            actorId: null,
            actorRole: null,
            actorName: null,
            teamId: null,
            subject: normalizedTicker,
            outcome: 'success',
            details: { horizon: normalizedHorizon, requestId: req.requestId ?? null },
        });
        res.json({
            success: true,
            isFallback: false,
            fromCache: false,
            ...forecast.payload,
            modelGovernance: getQuantModelGovernance(normalizedHorizon, false),
            provenance: buildProvenance({ provider: 'Quant Engine', mode: 'live', sourceType: 'quant' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: 1 }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
            modelRunId,
        });
        return;
    }

    console.error(`[QuantRoute] Quant proxy failed for ${normalizedTicker}. Using fallback:`, forecast.reason);
    recordQuantForecast('fallback');
    const modelRunId = await recordModelRun({
        teamId: req.teamContext?.teamId ?? null,
        actorId: req.user?.id ?? null,
        route: `/api/quant/${normalizedHorizon}`,
        modelFamily: 'quant_forecast',
        modelName: normalizedHorizon,
        promptVersion: 'quant-route-v1',
        input: { normalizedHorizon, normalizedTicker, sentiment_score, current_price, risk_free_rate },
        mode: 'fallback',
        outcome: 'fallback',
        failureStage: 'quant',
        durationMs: req.startedAt ? Date.now() - req.startedAt : undefined,
        sourceCount: 0,
    });
    await appendAuditEvent({
        category: 'system',
        action: 'Quant Forecast Fallback',
        actorId: null,
        actorRole: null,
        actorName: null,
        teamId: null,
        subject: normalizedTicker,
        outcome: 'failure',
        details: { horizon: normalizedHorizon, requestId: req.requestId ?? null, reason: forecast.reason ?? 'quant_unavailable' },
    });
    res.json({
        ...forecast.payload,
        modelGovernance: getQuantModelGovernance(normalizedHorizon, true),
        provenance: buildProvenance({
            provider: 'Quant Fallback',
            mode: 'fallback',
            sourceType: 'quant',
            degradationReason: forecast.reason ?? 'quant_unavailable',
        }),
        dataQuality: buildDataQuality({ status: 'degraded', observations: 0, errors: { quant: forecast.reason ?? 'quant_unavailable' } }),
        telemetry: buildTelemetry({ requestId: req.requestId ?? null, failureStage: 'quant' }),
        modelRunId,
    });
});

export default router;
