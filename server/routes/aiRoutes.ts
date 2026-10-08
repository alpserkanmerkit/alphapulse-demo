import { Router, Response } from 'express';
import { groundedDeepDive, groundedAgentAnalysis, getCacheStats } from '../services/groundingEngine';
import { analyzeHeadlineSimple } from '../services/analysisService';
import { processAdvisoryChat } from '../services/advisoryService';
import { AGENT_PERSONAS } from '../../shared/agentPersonas';
import { complianceMiddleware } from '../middleware/complianceCheck';
import { z } from 'zod';
import { AiRouteError } from '../services/aiRuntime';
import type { AiFailureStage } from '../../types';
import { buildDataQuality, buildProvenance, buildTelemetry } from '../shared/contracts/responseContracts';
import { appendAuditEvent } from '../shared/audit/auditLog';
import { AuthRequest, requireAuth, requireRole, requireTeamContext } from '../middleware/authMiddleware';
import { resolveActiveTeamContext } from '../shared/auth/teamContext';
import { recordModelRun } from '../shared/modelRun/modelRunLedger';
import { recordAiRoute } from '../shared/observability/runtimeMetrics';

const ChatSchema = z.object({ messages: z.array(z.any()).min(1) });
const AnalyzeSchema = z.object({ headline: z.string().min(1), category: z.string().optional(), source: z.string().optional() });
const DeepDiveSchema = z.object({ headline: z.string().min(1), category: z.string().optional(), tickers: z.array(z.string()).optional(), alphaScore: z.number().optional() });
const AgentAnalysisSchema = z.object({ headline: z.string().min(1), agentId: z.string().min(1), alphaScore: z.number().optional(), horizon: z.string().optional(), ticker: z.string().optional() });
const DebateSchema = z.object({ headline: z.string().min(1), alphaScore: z.number().optional(), newsId: z.string().optional() });

const router = Router();
const requireAiAccess = [requireAuth, requireTeamContext];
const requireAiAdmin = [requireAuth, requireTeamContext, requireRole('ADMIN')];

function elapsedMs(startedAt: number): number {
    return Date.now() - startedAt;
}

async function getAuditActorContext(req: AuthRequest) {
    if (!req.user) {
        return {
            actorId: null,
            actorRole: null,
            actorName: null,
            teamId: null,
        };
    }

    try {
        const team = await resolveActiveTeamContext(req.user);
        return {
            actorId: req.user.id,
            actorRole: req.user.role,
            actorName: req.user.email,
            teamId: team.teamId,
        };
    } catch (error) {
        console.warn('[AI Audit] Authenticated actor context unavailable:', error instanceof Error ? error.message : error);
        return {
            actorId: null,
            actorRole: null,
            actorName: null,
            teamId: null,
        };
    }
}

async function recordAiModelRun(req: AuthRequest, input: {
    route: string;
    modelFamily: string;
    modelName?: string | null;
    promptVersion?: string | null;
    payload: unknown;
    mode: string;
    outcome: 'success' | 'failure' | 'fallback' | 'cache_hit';
    failureStage?: string | null;
    durationMs?: number;
    sourceCount?: number;
}) {
    const actor = await getAuditActorContext(req);
    return recordModelRun({
        teamId: actor.teamId,
        actorId: actor.actorId,
        route: input.route,
        modelFamily: input.modelFamily,
        modelName: input.modelName ?? null,
        promptVersion: input.promptVersion ?? 'ai-routes-v1',
        input: input.payload,
        mode: input.mode,
        outcome: input.outcome,
        failureStage: input.failureStage ?? null,
        durationMs: input.durationMs,
        sourceCount: input.sourceCount ?? 0,
    });
}

async function recordAiAudit(req: AuthRequest, action: string, outcome: 'success' | 'failure', details: Record<string, unknown>) {
    const actor = await getAuditActorContext(req);
    await appendAuditEvent({
        category: 'ai',
        action,
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        actorName: actor.actorName,
        teamId: actor.teamId,
        subject: typeof details.headline === 'string' ? details.headline : null,
        outcome,
        details: {
            requestId: req.requestId ?? null,
            ...details,
        },
    });
}

async function recordWarRoomAudit(req: AuthRequest, headline: string, details: Record<string, unknown>) {
    const actor = await getAuditActorContext(req);
    await appendAuditEvent({
        category: 'war_room',
        action: 'AI War Room Debate',
        actorId: actor.actorId,
        actorRole: actor.actorRole,
        actorName: actor.actorName,
        teamId: actor.teamId,
        subject: headline,
        outcome: 'success',
        details,
    });
}

async function respondAiRouteError(req: AuthRequest, res: Response, error: unknown, fallbackError: string, startedAt: number, modelFamily = 'ai_runtime') {
    if (error instanceof AiRouteError) {
        recordAiRoute(req.path, 'fallback', error.failureStage);
        const modelRunId = await recordAiModelRun(req, {
            route: req.path,
            modelFamily,
            payload: req.body,
            mode: 'fallback',
            outcome: 'failure',
            failureStage: error.failureStage,
            durationMs: elapsedMs(startedAt),
        });
        return res.status(error.statusCode).json({
            success: false,
            error: fallbackError,
            reason: error.reason,
            notice: error.notice,
            durationMs: elapsedMs(startedAt),
            failureStage: error.failureStage,
            provenance: buildProvenance({ provider: 'AI Runtime', mode: 'fallback', sourceType: 'ai', degradationReason: error.reason }),
            dataQuality: buildDataQuality({ status: 'unavailable', errors: { [error.failureStage]: error.reason } }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null, durationMs: elapsedMs(startedAt), failureStage: error.failureStage }),
            modelRunId,
        });
    }

    console.error(`[Route] ${fallbackError}:`, error);
    recordAiRoute(req.path, 'fallback', 'unknown');
    const modelRunId = await recordAiModelRun(req, {
        route: req.path,
        modelFamily,
        payload: req.body,
        mode: 'fallback',
        outcome: 'failure',
        failureStage: 'unknown',
        durationMs: elapsedMs(startedAt),
    });
    return res.status(500).json({
        success: false,
        error: fallbackError,
        reason: 'backend_error',
        notice: 'Backend AI request failed.',
        durationMs: elapsedMs(startedAt),
        failureStage: 'unknown' satisfies AiFailureStage,
        provenance: buildProvenance({ provider: 'AI Runtime', mode: 'fallback', sourceType: 'ai', degradationReason: 'backend_error' }),
        dataQuality: buildDataQuality({ status: 'unavailable', errors: { unknown: 'backend_error' } }),
        telemetry: buildTelemetry({ requestId: req.requestId ?? null, durationMs: elapsedMs(startedAt), failureStage: 'unknown' }),
        modelRunId,
    });
}

// POST /api/ai/chat
// Interactive Advisory Orchestrator with Devil's Advocate mode
router.post('/chat', requireAiAccess, complianceMiddleware, async (req: AuthRequest, res: Response) => {
    const startedAt = Date.now();
    const parsed = ChatSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'messages array required' });
    }
    const { messages } = parsed.data;
    
    try {
        const replyText = await processAdvisoryChat(messages);
        const mode = process.env.GEMINI_API_KEY ? 'live' : 'simulation';
        recordAiRoute('/chat', mode, null);
        const modelRunId = await recordAiModelRun(req, {
            route: '/api/ai/chat',
            modelFamily: 'advisory_chat',
            modelName: mode === 'live' ? 'gemini' : 'simulation',
            payload: { messageCount: messages.length },
            mode,
            outcome: 'success',
            durationMs: elapsedMs(startedAt),
        });
        res.json({
            success: true,
            text: replyText,
            durationMs: elapsedMs(startedAt),
            failureStage: null,
            provenance: buildProvenance({ provider: 'AI Runtime', mode, sourceType: 'ai' }),
            dataQuality: buildDataQuality({ status: 'ready', observations: messages.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null, durationMs: elapsedMs(startedAt), failureStage: null }),
            modelRunId,
        });
        await recordAiAudit(req, 'AI Chat', 'success', { mode, messageCount: messages.length, durationMs: elapsedMs(startedAt) });
    } catch (err) {
        return await respondAiRouteError(req, res, err, 'Chat processing failed', startedAt, 'advisory_chat');
    }
});

// POST /api/ai/analyze
// Fast headline analysis — NO grounding (JSON schema, quick)
router.post('/analyze', requireAiAccess, complianceMiddleware, async (req: AuthRequest, res: Response) => {
    const startedAt = Date.now();
    const parsed = AnalyzeSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'headline required' });
    }
        const { headline, category, source } = parsed.data;
    try {
        const result = await analyzeHeadlineSimple(headline, category, source);
        recordAiRoute('/analyze', result.mode, null);
        const modelRunId = await recordAiModelRun(req, {
            route: '/api/ai/analyze',
            modelFamily: 'headline_analysis',
            modelName: result.mode === 'live' ? 'gemini' : 'simulation',
            payload: { headline, category, source },
            mode: result.mode,
            outcome: 'success',
            durationMs: elapsedMs(startedAt),
        });
        res.json({
            success: true,
            ...result,
            durationMs: elapsedMs(startedAt),
            failureStage: null,
            provenance: buildProvenance({ provider: 'AI Runtime', mode: result.mode, sourceType: 'ai', degradationReason: result.reason ?? null }),
            dataQuality: buildDataQuality({ status: result.mode === 'live' ? 'ready' : 'degraded', observations: 1 }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null, durationMs: elapsedMs(startedAt), failureStage: null }),
            modelRunId,
        });
        await recordAiAudit(req, 'AI Headline Analysis', 'success', { headline, mode: result.mode, reason: result.reason ?? null, durationMs: elapsedMs(startedAt) });
    } catch (err) {
        return await respondAiRouteError(req, res, err, 'Analysis failed', startedAt, 'headline_analysis');
    }
});

// POST /api/ai/deep-dive
// Deep Dive with optional grounding based on AlphaScore
router.post('/deep-dive', requireAiAccess, complianceMiddleware, async (req: AuthRequest, res: Response) => {
    const startedAt = Date.now();
    const parsed = DeepDiveSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'headline required' });
    }
    const { headline, category, tickers, alphaScore } = parsed.data;
    try {
        const result = await groundedDeepDive(
            headline,
            category || 'STOCKS',
            tickers || [],
            alphaScore || 0
        );
        recordAiRoute('/deep-dive', result.mode, null);
        const modelRunId = await recordAiModelRun(req, {
            route: '/api/ai/deep-dive',
            modelFamily: 'grounded_deep_dive',
            modelName: result.mode === 'live' ? 'gemini_grounded' : 'simulation',
            payload: { headline, category, tickers, alphaScore },
            mode: result.mode,
            outcome: result.mode === 'fallback' ? 'fallback' : 'success',
            durationMs: elapsedMs(startedAt),
            sourceCount: result.sources.length,
        });
        res.json({
            success: true,
            ...result.data,
            mode: result.mode,
            reason: result.reason,
            notice: result.notice,
            groundingUsed: result.groundingUsed,
            sources: result.sources,
            webSearchQueries: result.webSearchQueries,
            fromCache: result.fromCache,
            durationMs: elapsedMs(startedAt),
            failureStage: null,
            provenance: buildProvenance({ provider: 'AI Grounding Runtime', mode: result.mode, sourceType: 'ai', fromCache: result.fromCache, degradationReason: result.reason ?? null }),
            dataQuality: buildDataQuality({ status: result.mode === 'live' ? 'ready' : 'degraded', observations: result.sources.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null, durationMs: elapsedMs(startedAt), failureStage: null }),
            modelRunId,
        });
        await recordAiAudit(req, 'AI Deep Dive', 'success', { headline, mode: result.mode, groundingUsed: result.groundingUsed, sourceCount: result.sources.length, durationMs: elapsedMs(startedAt) });
    } catch (err) {
        return await respondAiRouteError(req, res, err, 'Deep Dive failed', startedAt, 'grounded_deep_dive');
    }
});

// POST /api/ai/agent-analysis
// Single AI agent analysis for progressive UI rendering
router.post('/agent-analysis', requireAiAccess, complianceMiddleware, async (req: AuthRequest, res: Response) => {
    const startedAt = Date.now();
    const parsed = AgentAnalysisSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'headline and agentId required' });
    }
    const { headline, agentId, alphaScore, horizon, ticker } = parsed.data;

    try {
        const agent = AGENT_PERSONAS.find((a) => a.id === agentId);
        if (!agent) return res.status(400).json({ success: false, error: 'Invalid agentId' });

        const horizonArg = horizon ?? 'long';

        const result = await groundedAgentAnalysis(
            headline,
            agent.systemPrompt,
            agent.id,
            alphaScore || 0,
            horizonArg,
            ticker
        );

        recordAiRoute('/agent-analysis', result.mode, result.failureStage ?? null);
        const modelRunId = await recordAiModelRun(req, {
            route: '/api/ai/agent-analysis',
            modelFamily: 'war_room_agent',
            modelName: result.mode === 'live' ? 'gemini_grounded_agent' : 'simulation',
            payload: { headline, agentId, alphaScore, horizon: horizonArg, ticker },
            mode: result.mode,
            outcome: result.mode === 'fallback' ? 'fallback' : 'success',
            failureStage: result.failureStage ?? null,
            durationMs: elapsedMs(startedAt),
            sourceCount: result.sources.length,
        });
        res.json({
            success: true,
            agentId: agent.id,
            agentName: agent.name,
            agentIcon: agent.icon,
            agentColor: agent.color,
            position: result.data.position ?? 'WAIT',
            confidence: result.data.confidence ?? 50,
            reasoning: result.data.reasoning ?? '',
            evidence: result.data.evidence ?? [],
            scenarios: result.data.scenarios ?? [],
            sources: result.sources,
            groundingUsed: result.groundingUsed,
            mode: result.mode,
            reason: result.reason,
            notice: result.notice,
            failureStage: result.failureStage ?? null,
            quantData: result.quantData,
            timestamp: Date.now(),
            durationMs: elapsedMs(startedAt),
            provenance: buildProvenance({ provider: 'AI Agent Runtime', mode: result.mode, sourceType: 'ai', degradationReason: result.reason ?? null }),
            dataQuality: buildDataQuality({ status: result.mode === 'live' ? 'ready' : 'degraded', observations: result.sources.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null, durationMs: elapsedMs(startedAt), failureStage: result.failureStage ?? null }),
            modelRunId,
        });
        await recordAiAudit(req, 'AI Agent Analysis', 'success', { headline, agentId: agent.id, mode: result.mode, groundingUsed: result.groundingUsed, durationMs: elapsedMs(startedAt) });
    } catch (err) {
        return await respondAiRouteError(req, res, err, 'Agent analysis failed', startedAt, 'war_room_agent');
    }
});

// POST /api/ai/debate
// Multi-agent debate — all 4 agents, with optional grounding
router.post('/debate', requireAiAccess, complianceMiddleware, async (req: AuthRequest, res: Response) => {
    const startedAt = Date.now();
    const parsed = DebateSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ success: false, error: 'headline required' });
    }
    const { headline, alphaScore, newsId } = parsed.data;

    try {
        const agentResults = [];

        // Run agents sequentially with 300ms gaps to respect rate limits
        for (const agent of AGENT_PERSONAS) {
            const result = await groundedAgentAnalysis(
                headline,
                agent.systemPrompt,
                agent.id,
                alphaScore || 0
            );

            agentResults.push({
                agentId: agent.id,
                agentName: agent.name,
                agentIcon: agent.icon,
                agentColor: agent.color,
                mode: result.mode,
                position: result.data.position ?? 'WAIT',
                confidence: result.data.confidence ?? 50,
                reasoning: result.data.reasoning ?? '',
                evidence: result.data.evidence ?? [],
                scenarios: result.data.scenarios ?? [],
                sources: result.sources,
                groundingUsed: result.groundingUsed,
                timestamp: Date.now(),
            });

            // Rate limit buffer between agents
            await new Promise((r) => setTimeout(r, 300));
        }

        // Build consensus
        const total = agentResults.length;
        const longCount = agentResults.filter((a) => a.position === 'LONG').length;
        const shortCount = agentResults.filter((a) => a.position === 'SHORT').length;
        const hedgeCount = agentResults.filter((a) => a.position === 'HEDGE').length;
        const avgConfidence = Math.round(agentResults.reduce((s, a) => s + a.confidence, 0) / total);

        const direction =
            longCount > shortCount && longCount >= hedgeCount ? 'LONG' :
                shortCount > longCount && shortCount >= hedgeCount ? 'SHORT' :
                    hedgeCount > 0 ? 'HEDGE' : 'WAIT';

        const groundingUsedCount = agentResults.filter((a) => a.groundingUsed).length;
        const debateMode = agentResults.some((a) => a.mode === 'fallback')
            ? 'fallback'
            : agentResults.every((a) => a.mode === 'live') ? 'live' : 'simulation';
        const sourceCount = agentResults.reduce((totalSources, agent) => totalSources + agent.sources.length, 0);
        recordAiRoute('/debate', debateMode, null);
        const modelRunId = await recordAiModelRun(req, {
            route: '/api/ai/debate',
            modelFamily: 'war_room_debate',
            modelName: debateMode === 'live' ? 'gemini_grounded_agents' : 'simulation',
            payload: { headline, alphaScore, newsId },
            mode: debateMode,
            outcome: debateMode === 'fallback' ? 'fallback' : 'success',
            durationMs: elapsedMs(startedAt),
            sourceCount,
        });

        res.json({
            success: true,
            newsId,
            arguments: agentResults,
            mode: debateMode,
            consensus: {
                direction,
                confidence: avgConfidence,
                bullishProbability: Math.round((longCount / total) * 100),
                bearishProbability: Math.round((shortCount / total) * 100),
                neutralProbability: Math.round(((hedgeCount + (total - longCount - shortCount)) / total) * 100),
                summary: `${total} agents debated. ${longCount} LONG / ${shortCount} SHORT / ${hedgeCount} HEDGE. Consensus: ${direction} at ${avgConfidence}% confidence. ${groundingUsedCount > 0 ? `${groundingUsedCount} agents used live web grounding.` : debateMode === 'simulation' ? 'Simulation mode response.' : 'No live grounding used.'}`,
            },
            uncertainty: longCount === shortCount ? 'HIGH' : Math.abs(longCount - shortCount) === 1 ? 'MEDIUM' : 'LOW',
            groundingUsed: groundingUsedCount > 0,
            provenance: buildProvenance({ provider: 'AI War Room Runtime', mode: debateMode, sourceType: 'ai', degradationReason: debateMode === 'live' ? null : 'partial_or_simulated_agent_output' }),
            dataQuality: buildDataQuality({ status: debateMode === 'live' ? 'ready' : 'degraded', observations: agentResults.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null, durationMs: elapsedMs(startedAt), failureStage: null }),
            modelRunId,
        });
        await recordWarRoomAudit(req, headline, {
            requestId: req.requestId ?? null,
            mode: debateMode,
            groundingUsed: groundingUsedCount > 0,
            agentCount: agentResults.length,
            durationMs: elapsedMs(startedAt),
        });
    } catch (err) {
        console.error('[Route] /ai/debate error:', err);
        recordAiRoute('/debate', 'fallback', 'route');
        const modelRunId = await recordAiModelRun(req, {
            route: '/api/ai/debate',
            modelFamily: 'war_room_debate',
            payload: req.body,
            mode: 'fallback',
            outcome: 'failure',
            failureStage: 'route',
            durationMs: elapsedMs(startedAt),
        });
        res.status(500).json({
            success: false,
            error: 'Debate failed',
            provenance: buildProvenance({ provider: 'AI War Room Runtime', mode: 'fallback', sourceType: 'ai', degradationReason: 'backend_error' }),
            dataQuality: buildDataQuality({ status: 'unavailable', errors: { route: 'backend_error' } }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null, durationMs: elapsedMs(startedAt), failureStage: 'route' }),
            modelRunId,
        });
    }
});

// GET /api/ai/cache-stats
// Returns grounding cache statistics
router.get('/cache-stats', requireAiAdmin, (_req: AuthRequest, res: Response) => {
    const stats = getCacheStats();
    res.json({ success: true, ...stats });
});

export default router;
