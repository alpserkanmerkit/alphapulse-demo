/* eslint-disable @typescript-eslint/no-explicit-any */
import { GoogleGenAI, Type } from '@google/genai';
import { withRetry } from '../../shared/retry';
import { getQuantForecastWithFallback } from './quantForecastService';
import { AiRouteError, AiRouteReason, toAiRouteError, withAiTimeout } from './aiRuntime';
import { AI_RUNTIME_CONFIG } from '../../shared/aiConfig';
import type { AiFailureStage, DataMode } from '../../types';
import { getCachedNewsSnapshot } from './rssAggregator';
import { isDemoMode } from '../demo/demoMode';
import { DEMO_AI_NOTICE, demoAgentAnalysis, demoDeepDive } from '../demo/demoAi';

interface CacheEntry {
    data: string;
    sources: GroundingSource[];
    webSearchQueries: string[];
    timestamp: number;
    ttl: number;
}

export interface GroundingSource {
    title: string;
    uri: string;
}

const groundingCache = new Map<string, CacheEntry>();
const MAX_CACHE_SIZE = 500;
const TICKER_TTL = 15 * 60 * 1000;
const GENERAL_TTL = 30 * 60 * 1000;
const HISTORY_TTL = 24 * 60 * 60 * 1000;
const WAR_ROOM_MARKET_GROUNDING_TIMEOUT_MS = 6500;
const WAR_ROOM_HISTORY_GROUNDING_TIMEOUT_MS = 3500;

const hasGeminiKey = () => Boolean(process.env.GEMINI_API_KEY);

type QuantContextStatus = 'ready' | 'fallback' | 'timeout' | 'unavailable';

interface QuantContextResult {
    data: any | null;
    status: QuantContextStatus;
    reason: string | null;
}

function buildCacheKey(type: string, context: string): string {
    const hour = Math.floor(Date.now() / (60 * 60 * 1000));
    return `${type}:${context.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80)}:${hour}`;
}

function getCached(key: string): CacheEntry | null {
    const entry = groundingCache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > entry.ttl) {
        groundingCache.delete(key);
        return null;
    }

    return entry;
}

function setCache(key: string, data: string, sources: GroundingSource[], queries: string[], ttl: number): void {
    if (groundingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = groundingCache.keys().next().value;
        if (firstKey) groundingCache.delete(firstKey);
    }

    groundingCache.set(key, { data, sources, webSearchQueries: queries, timestamp: Date.now(), ttl });
}

function compactText(value: string, maxLength = 1800): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function summarizeQuantData(quantData: any, ticker: string | null, horizon: string): string {
    if (!quantData) return '';

    const target = quantData.target_12_36_months
        ?? quantData.target_6_12_months
        ?? quantData.target_price
        ?? quantData.mean_target
        ?? quantData.final_price;
    const current = quantData.current_price
        ?? quantData.initial_price
        ?? quantData.entry_price;
    const model = quantData.model_source
        ?? quantData.model
        ?? (horizon === 'short' ? 'Monte Carlo' : horizon === 'medium' ? 'ARIMAX/GARCH' : 'DCF/Fama-French');
    const assumptions = Array.isArray(quantData.model_assumptions) ? quantData.model_assumptions.slice(0, 3).join('; ') : null;
    const warnings = Array.isArray(quantData.warnings) ? quantData.warnings.slice(0, 2).join('; ') : null;

    return [
        `Ticker: ${ticker ?? 'unknown'}`,
        `Horizon: ${horizon}`,
        `Model: ${model}`,
        current != null ? `Current price: ${current}` : null,
        target != null ? `Target price: ${target}` : null,
        quantData.upper_band != null ? `Upper band: ${quantData.upper_band}` : null,
        quantData.lower_band != null ? `Lower band: ${quantData.lower_band}` : null,
        quantData.market_regime ? `Market regime: ${quantData.market_regime}` : null,
        assumptions ? `Assumptions: ${assumptions}` : null,
        warnings ? `Warnings: ${warnings}` : null,
    ].filter(Boolean).join('\n');
}

function buildQuantGroundingSource(ticker: string | null, horizon: string): GroundingSource | null {
    if (!ticker) return null;
    return {
        title: `AlphaPulse Quant Engine: ${ticker} ${horizon} forecast`,
        uri: `alphapulse://quant/${encodeURIComponent(ticker)}/${encodeURIComponent(horizon)}`,
    };
}

function isFallbackQuantData(quantData: any): boolean {
    return Boolean(quantData?.is_fallback || quantData?.model_source === 'fallback');
}

function buildSimulatedDeepDive(headline: string): { content: string; scenarios: any[] } {
    return {
        content: `**1. The Event (What)**\nSimulation mode is active for "${headline}".\n\n**2. Context (Background)**\nBackend orchestration is available but live Gemini analysis is disabled until GEMINI_API_KEY is configured.\n\n**3. Chain Impact (Ripple Effects)**\nThe system can still surface likely cross-asset reactions using deterministic fallback heuristics.\n\n**4. Forecast (Outlook)**\nTreat this as a mock contract response, not a grounded market conclusion.`,
        scenarios: [
            { direction: 'WAIT', asset: 'Broad Market', rationale: 'Live analysis is unavailable, so preserve optionality.', risk: 'LOW' },
            { direction: 'HEDGE', asset: 'Volatility Basket', rationale: 'Fallback mode increases uncertainty around sizing.', risk: 'MEDIUM' },
        ],
    };
}

function buildSimulatedAgentAnalysis(agentId: string, headline: string, quantData: any): any {
    const quantNote = quantData ? ' Quant engine data is attached, but the narrative layer is still simulated.' : '';

    switch (agentId) {
        case 'agent-bear':
            return {
                position: 'SHORT',
                confidence: 58,
                reasoning: `Simulation mode: downside risks remain elevated for "${headline}". Without live Gemini grounding, treat this as a defensive placeholder.${quantNote}`,
                evidence: ['Simulation fallback active', 'Downside bias preserved for risk review'],
                scenarios: [{ direction: 'SHORT', asset: 'Equity Beta', rationale: 'Reduce directional exposure until live analysis returns.', risk: 'MEDIUM' }],
            };
        case 'agent-bull':
            return {
                position: 'LONG',
                confidence: 56,
                reasoning: `Simulation mode: the headline still maps to a growth-positive pattern, but confidence is capped until live analysis is restored.${quantNote}`,
                evidence: ['Simulation fallback active', 'Growth-biased heuristic matched the headline'],
                scenarios: [{ direction: 'LONG', asset: 'Sector Leaders', rationale: 'Keep sizing modest because the thesis is not live-grounded.', risk: 'MEDIUM' }],
            };
        case 'agent-risk':
            return {
                position: 'HEDGE',
                confidence: 61,
                reasoning: `Simulation mode: risk control takes priority while live compliance-aware reasoning is unavailable.${quantNote}`,
                evidence: ['Simulation fallback active', 'Risk officer defaults to protection in uncertain mode'],
                scenarios: [{ direction: 'HEDGE', asset: 'Portfolio Overlay', rationale: 'Favor protection until services are fully live.', risk: 'LOW' }],
            };
        default:
            return {
                position: 'WAIT',
                confidence: 54,
                reasoning: `Simulation mode: statistical confirmation is incomplete for "${headline}".${quantNote}`,
                evidence: ['Simulation fallback active', 'Quant confirmation requires live narrative synthesis'],
                scenarios: [{ direction: 'WAIT', asset: 'Cash Buffer', rationale: 'Wait for live signal confirmation.', risk: 'LOW' }],
            };
    }
}

function buildFallbackAgentAnalysis(agentId: string, headline: string, quantData: any, failureSummary: string): any {
    const quantNote = quantData ? ' Quant context is still attached for sizing discipline.' : '';

    switch (agentId) {
        case 'agent-bear':
            return {
                position: 'SHORT',
                confidence: 52,
                reasoning: `Degraded live mode: the bear case is available as a fallback while ${failureSummary} for "${headline}".${quantNote}`,
                evidence: ['Model response degraded', 'Downside review preserved'],
                scenarios: [{ direction: 'SHORT', asset: 'Risk Assets', rationale: 'Keep downside protection active until live synthesis recovers.', risk: 'MEDIUM' }],
            };
        case 'agent-bull':
            return {
                position: 'LONG',
                confidence: 53,
                reasoning: `Degraded live mode: the bullish case is preserved with capped confidence while ${failureSummary}.${quantNote}`,
                evidence: ['Model response degraded', 'Upside thesis capped for uncertainty'],
                scenarios: [{ direction: 'LONG', asset: 'Quality Leaders', rationale: 'Use smaller sizing until confirmed by live analysis.', risk: 'MEDIUM' }],
            };
        case 'agent-risk':
            return {
                position: 'HEDGE',
                confidence: 60,
                reasoning: `Degraded live mode: risk control takes priority because ${failureSummary}.${quantNote}`,
                evidence: ['Model response degraded', 'Portfolio protection prioritized'],
                scenarios: [{ direction: 'HEDGE', asset: 'Portfolio Overlay', rationale: 'Hedge directional exposure until live reasoning stabilizes.', risk: 'LOW' }],
            };
        default:
            return {
                position: 'WAIT',
                confidence: 50,
                reasoning: `Degraded live mode: statistical confirmation is incomplete because ${failureSummary} for "${headline}".${quantNote}`,
                evidence: ['Model response degraded', 'Awaiting confirmed signal'],
                scenarios: [{ direction: 'WAIT', asset: 'Cash Buffer', rationale: 'Wait for a validated live signal.', risk: 'LOW' }],
            };
    }
}

function classifyAgentModelFailure(error: unknown, agentId: string): { reason: AiRouteReason; notice: string; failureStage: AiFailureStage; summary: string } {
    if (error instanceof AiRouteError) {
        return {
            reason: error.reason,
            notice: error.notice,
            failureStage: error.failureStage,
            summary: error.reason === 'backend_timeout' ? 'the live model timed out' : 'the live model request failed',
        };
    }

    if (error instanceof SyntaxError) {
        return {
            reason: 'backend_error',
            notice: `Live War Room analysis returned invalid JSON for ${agentId}; fallback reasoning is shown.`,
            failureStage: 'model',
            summary: 'the live model returned invalid JSON',
        };
    }

    return {
        reason: 'backend_error',
        notice: `Live War Room analysis degraded for ${agentId}; fallback reasoning is shown.`,
        failureStage: 'model',
        summary: 'the live model response failed validation',
    };
}

async function fetchQuantContext(ticker: string | null, horizon: string): Promise<QuantContextResult> {
    if (!ticker) return { data: null, status: 'unavailable', reason: null };

    const endpoint = horizon === 'short' ? 'short-term' : horizon === 'medium' ? 'medium-term' : 'long-term';
    const timeoutMs = AI_RUNTIME_CONFIG.warRoomAgentQuantContextTimeoutMs;

    try {
        const result = await getQuantForecastWithFallback(
            endpoint,
            ticker,
            { risk_free_rate: 0.04 },
            timeoutMs
        );

        const data = result.payload.data ?? null;
        if (!data) {
            return { data: null, status: 'unavailable', reason: result.reason ?? 'empty_quant_payload' };
        }

        if (result.isFallback || isFallbackQuantData(data)) {
            return { data, status: 'fallback', reason: result.reason ?? 'quant_fallback' };
        }

        return { data, status: 'ready', reason: null };
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'quant_unavailable';
        return { data: null, status: 'unavailable', reason };
    }
}

async function waitForOptionalQuantContext(quantContextPromise: Promise<QuantContextResult>): Promise<QuantContextResult> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
        return await Promise.race([
            quantContextPromise,
            new Promise<QuantContextResult>((resolve) => {
                timeoutId = setTimeout(() => {
                    resolve({
                        data: null,
                        status: 'timeout',
                        reason: `quant_context_timeout_after_${AI_RUNTIME_CONFIG.warRoomAgentQuantContextTimeoutMs}ms`,
                    });
                }, AI_RUNTIME_CONFIG.warRoomAgentQuantContextTimeoutMs);
            }),
        ]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}

function buildQuantNotice(status: QuantContextStatus, reason: string | null): string | null {
    if (status === 'ready' || (status === 'unavailable' && !reason)) return null;
    if (status === 'timeout') {
        return `Quant context timed out after ${AI_RUNTIME_CONFIG.warRoomAgentQuantContextTimeoutMs}ms, so debate continues without a quantitative anchor.`;
    }
    if (status === 'fallback') {
        return 'Quant preview returned fallback output, so debate continues without using it as hard model context.';
    }
    return `Quant preview is unavailable${reason ? ` (${reason})` : ''}, so debate continues without a quantitative anchor.`;
}

function getLiveFeedGrounding(headline: string, ticker: string | null): { text: string; sources: GroundingSource[] } {
    const normalizedTicker = ticker?.toUpperCase() ?? null;
    const headlineTerms = new Set(headline.toLowerCase().split(/\W+/).filter((term) => term.length > 4));
    const matches = getCachedNewsSnapshot()
        .filter((item) => {
            if (!item.url) return false;
            if (normalizedTicker && item.relatedTickers?.includes(normalizedTicker)) return true;
            const itemTerms = item.headline.toLowerCase().split(/\W+/).filter((term) => term.length > 4);
            return itemTerms.some((term) => headlineTerms.has(term));
        })
        .slice(0, 4);

    return {
        text: matches
            .map((item) => `- ${item.headline} (${item.source}, ${new Date(item.timestamp).toISOString()})`)
            .join('\n'),
        sources: matches.map((item) => ({ title: `${item.source}: ${item.headline}`, uri: item.url! })),
    };
}

function inferTicker(headline: string): string | null {
    const tickerMap: Record<string, string> = {
        apple: 'AAPL',
        microsoft: 'MSFT',
        google: 'GOOGL',
        alphabet: 'GOOGL',
        amazon: 'AMZN',
        tesla: 'TSLA',
        nvidia: 'NVDA',
        meta: 'META',
        netflix: 'NFLX',
        bitcoin: 'BTC-USD',
        ethereum: 'ETH-USD',
        intel: 'INTC',
        amd: 'AMD',
        palantir: 'PLTR',
        coinbase: 'COIN',
        oil: 'XOM',
    };

    const headlineLower = headline.toLowerCase();
    for (const [name, symbol] of Object.entries(tickerMap)) {
        if (headlineLower.includes(name)) return symbol;
    }

    const tickerMatch = headline.match(/\$([A-Z]{1,5}(?:-USD|=F)?)/);
    return tickerMatch ? tickerMatch[1] : null;
}

export function shouldUseGrounding(score: number | undefined, context: 'deep-dive' | 'war-room' | 'news-analysis'): boolean {
    if (!hasGeminiKey()) return false;
    if (context === 'war-room') return true;
    if (score === undefined) return false;
    if (context === 'deep-dive') return score >= 70;
    return false;
}

export interface GroundedResult<T> {
    data: T;
    sources: GroundingSource[];
    webSearchQueries: string[];
    fromCache: boolean;
    groundingUsed: boolean;
    mode: DataMode;
    reason: AiRouteReason | null;
    notice?: string;
    failureStage?: AiFailureStage | null;
    quantData?: any;
}

export async function groundedQuery(
    prompt: string,
    cacheKey: string,
    ttl: 'ticker' | 'general' | 'history' = 'general',
    timeoutMs = 20000
): Promise<{ text: string; sources: GroundingSource[]; queries: string[] }> {
    const key = buildCacheKey('ground', cacheKey);
    const cached = getCached(key);

    if (cached) {
        return { text: cached.data, sources: [...cached.sources], queries: [...cached.webSearchQueries] };
    }

    if (!hasGeminiKey()) {
        throw new Error('GEMINI_API_KEY not configured');
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await withAiTimeout(
        withRetry(() => ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
                tools: [{ googleSearch: {} }],
            },
        })),
        timeoutMs,
        'Backend grounding timed out before live search completed.',
        'grounding'
    );

    const text = response.text ?? '';
    const meta = (response as any).candidates?.[0]?.groundingMetadata;
    const sources: GroundingSource[] = (meta?.groundingChunks ?? [])
        .filter((chunk: any) => chunk?.web)
        .map((chunk: any) => ({ title: chunk.web.title ?? '', uri: chunk.web.uri ?? '' }))
        .slice(0, 6);
    const queries: string[] = meta?.webSearchQueries ?? [];
    const ttlMs = ttl === 'history' ? HISTORY_TTL : ttl === 'ticker' ? TICKER_TTL : GENERAL_TTL;

    setCache(key, text, [...sources], [...queries], ttlMs);
    return { text, sources, queries };
}

function demoGroundedResult<T>(data: T): GroundedResult<T> {
    return {
        data,
        sources: [],
        webSearchQueries: [],
        fromCache: false,
        groundingUsed: false,
        mode: 'simulation',
        reason: 'ai_simulation',
        notice: DEMO_AI_NOTICE,
    };
}

function joinNotices(notices: string[]): string | undefined {
    return notices.length > 0 ? Array.from(new Set(notices)).join(' ') : undefined;
}

export async function groundedDeepDive(
    headline: string,
    category: string,
    tickers: string[],
    alphaScore: number
): Promise<GroundedResult<{ content: string; scenarios: any[] }>> {
    if (isDemoMode()) return demoGroundedResult(demoDeepDive(headline));

    if (!hasGeminiKey()) {
        return {
            data: buildSimulatedDeepDive(headline),
            sources: [],
            webSearchQueries: [],
            fromCache: false,
            groundingUsed: false,
            mode: 'simulation',
            reason: 'ai_simulation',
            notice: 'Backend AI is in simulation mode because GEMINI_API_KEY is missing.',
        };
    }

    const useGrounding = shouldUseGrounding(alphaScore, 'deep-dive');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    let contextText = '';
    let sources: GroundingSource[] = [];
    let queries: string[] = [];
    const notices: string[] = [];
    let reason: AiRouteReason | null = null;

    if (useGrounding) {
        const cacheKey = tickers.length > 0 ? tickers[0] : category;
        const searchPrompt = `Search for the latest financial market data, analyst opinions, and news related to: "${headline}".
Include current prices, recent analyst ratings, related market movements, and context.
Summarize the most important findings in 3-4 paragraphs.`;

        try {
            const result = await groundedQuery(searchPrompt, cacheKey, tickers.length > 0 ? 'ticker' : 'general');
            contextText = result.text;
            sources = result.sources;
            queries = result.queries;
        } catch (error) {
            console.warn('[Grounding] Deep Dive grounding failed, proceeding without grounding:', (error as Error).message);
            notices.push('Live Deep Dive completed without web grounding.');
            reason = 'grounding_unavailable';
        }
    }

    const analysisPrompt = `You are a Senior Institutional Fund Manager performing a Deep Dive Analysis.

NEWS HEADLINE: "${headline}"
CATEGORY: ${category}
${contextText ? `\nCURRENT MARKET CONTEXT (from live web search):\n${contextText}\n` : ''}

Produce a Deep Dive report with:
PART 1 - REPORT (250-300 words, markdown):
**1. The Event (What)**
**2. Context (Background)**
**3. Chain Impact (Ripple Effects)**
**4. Forecast (Outlook)**

PART 2 - TRADING SCENARIOS (3-5): Cross-market positions (LONG/SHORT/HEDGE/WAIT) with specific assets and rationale.

Return JSON:
{
  "content": "<markdown report>",
  "scenarios": [{"direction":"LONG|SHORT|HEDGE|WAIT","asset":"<asset name>","rationale":"<why>","risk":"LOW|MEDIUM|HIGH"}]
}`;

    try {
        const response = await withAiTimeout(
            withRetry(() => ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: analysisPrompt,
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: 'object' as any,
                        properties: {
                            content: { type: 'string' as any },
                            scenarios: {
                                type: 'array' as any,
                                items: {
                                    type: 'object' as any,
                                    properties: {
                                        direction: { type: 'string' as any, enum: ['LONG', 'SHORT', 'HEDGE', 'WAIT'] },
                                        asset: { type: 'string' as any },
                                        rationale: { type: 'string' as any },
                                        risk: { type: 'string' as any, enum: ['LOW', 'MEDIUM', 'HIGH'] },
                                    },
                                    required: ['direction', 'asset', 'rationale', 'risk'],
                                },
                            },
                        },
                        required: ['content', 'scenarios'],
                    },
                },
            })),
            AI_RUNTIME_CONFIG.deepDiveClientTimeoutMs,
            'Backend AI timed out before Deep Dive generation completed.',
            'model'
        );

        const parsed = JSON.parse(response.text ?? '{}');
        return {
            data: parsed,
            sources,
            webSearchQueries: queries,
            fromCache: false,
            groundingUsed: useGrounding && sources.length > 0,
            mode: 'live',
            reason,
            notice: joinNotices(notices),
        };
    } catch (error) {
        throw toAiRouteError(error, 'Backend Deep Dive request failed.', 'model');
    }
}

export async function groundedAgentAnalysis(
    headline: string,
    agentSystemPrompt: string,
    agentId: string,
    alphaScore: number,
    horizon: string = 'long',
    tickerOverride?: string
): Promise<GroundedResult<any>> {
    if (isDemoMode()) return demoGroundedResult(demoAgentAnalysis(agentId, headline));

    const ticker = tickerOverride?.trim().toUpperCase() || inferTicker(headline);
    const quantContextPromise = fetchQuantContext(ticker, horizon).catch((error) => {
        console.warn(`[Grounding] Quant context failed for ${ticker ?? 'unknown ticker'}:`, error instanceof Error ? error.message : error);
        return { data: null, status: 'unavailable', reason: error instanceof Error ? error.message : 'quant_unavailable' } satisfies QuantContextResult;
    });

    if (!hasGeminiKey()) {
        const quantContext = await waitForOptionalQuantContext(quantContextPromise);
        const quantData = quantContext.status === 'ready' || quantContext.status === 'fallback' ? quantContext.data : null;
        const quantNotice = ticker ? buildQuantNotice(quantContext.status, quantContext.reason) : null;
        return {
            data: buildSimulatedAgentAnalysis(agentId, headline, quantContext.status === 'ready' ? quantContext.data : null),
            sources: [],
            webSearchQueries: [],
            fromCache: false,
            groundingUsed: false,
            mode: 'simulation',
            reason: 'ai_simulation',
            notice: ['Backend AI is in simulation mode because GEMINI_API_KEY is missing.', quantNotice].filter(Boolean).join(' '),
            quantData,
        };
    }

    const useGrounding = shouldUseGrounding(alphaScore, 'war-room');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    let contextText = '';
    let historicalContext = '';
    let sources: GroundingSource[] = [];
    let queries: string[] = [];
    const notices: string[] = [];
    let reason: AiRouteReason | null = null;

    const marketGroundingPromise = useGrounding
        ? groundedQuery(
            `Find the latest market data and news relevant to this financial event: "${headline}".
Focus on current prices, analyst views, recent market movements, and related news from the past 24 hours.`,
            `warroom:${headline.slice(0, 60)}`,
            'general',
            WAR_ROOM_MARKET_GROUNDING_TIMEOUT_MS
        ).catch((error) => {
            console.warn(`[Grounding] Agent ${agentId} grounding failed:`, (error as Error).message);
            return null;
        })
        : Promise.resolve(null);

    const historyGroundingPromise = useGrounding && ticker
        ? groundedQuery(
            `Search the historical corporate background over the last 24 months for "${ticker}".
Focus on contracts, mergers, acquisitions, regulatory actions, litigation, and long-term product roadmaps.`,
            `history:${ticker}`,
            'history',
            WAR_ROOM_HISTORY_GROUNDING_TIMEOUT_MS
        ).catch((error) => {
            console.warn(`[Grounding] Historical dossier failed for ${ticker}:`, (error as Error).message);
            return null;
        })
        : Promise.resolve(null);

    const [quantContext, marketGrounding, historyGrounding] = await Promise.all([
        waitForOptionalQuantContext(quantContextPromise),
        marketGroundingPromise,
        historyGroundingPromise,
    ]);
    const quantData = quantContext.status === 'ready' || quantContext.status === 'fallback' ? quantContext.data : null;
    const promptQuantData = quantContext.status === 'ready' ? quantContext.data : null;

    if (useGrounding) {
        if (marketGrounding) {
            contextText = compactText(marketGrounding.text);
            sources = [...marketGrounding.sources];
            queries = [...marketGrounding.queries];
        } else {
            const localGrounding = getLiveFeedGrounding(headline, ticker);
            if (localGrounding.sources.length > 0) {
                contextText = localGrounding.text;
                sources = localGrounding.sources;
                queries = ['AlphaPulse live feed cache'];
            }
        }

        if (historyGrounding) {
            historicalContext = `\n\n[HISTORICAL DOSSIER]\n${compactText(historyGrounding.text, 900)}\n`;
            sources.push(...historyGrounding.sources);
            queries.push(...historyGrounding.queries);
        }
    }

    if (useGrounding && sources.length === 0) {
        const localGrounding = getLiveFeedGrounding(headline, ticker);
        if (localGrounding.sources.length > 0) {
            contextText = contextText || localGrounding.text;
            sources = localGrounding.sources;
            queries = queries.length > 0 ? queries : ['AlphaPulse live feed cache'];
            reason = null;
        }
    }

    const quantSummary = summarizeQuantData(promptQuantData, ticker, horizon);
    if (useGrounding && quantSummary) {
        contextText = [contextText, `[LIVE QUANT CONTEXT]\n${quantSummary}`].filter(Boolean).join('\n\n');
        const quantSource = buildQuantGroundingSource(ticker, horizon);
        if (quantSource && !sources.some((source) => source.uri === quantSource.uri)) {
            sources.push(quantSource);
        }
        if (!queries.includes('AlphaPulse Quant Engine')) {
            queries.push('AlphaPulse Quant Engine');
        }
        reason = null;
    }

    if (useGrounding && sources.length === 0) {
        notices.push('Live debate analysis completed without web grounding.');
        reason = 'grounding_unavailable';
    }

    if (ticker && quantContext.status !== 'ready') {
        const quantNotice = buildQuantNotice(quantContext.status, quantContext.reason);
        if (quantNotice) notices.push(quantNotice);
        if (!reason) {
            reason = 'quant_unavailable';
        }
    }

    const quantContextText = quantSummary ? `\n\n[QUANT ENGINE DATA HORIZON: ${horizon}]\n${quantSummary}\nUse these mathematical outputs as hard context when they are relevant.\n` : '';
    const agentPrompt = `${agentSystemPrompt}

NEWS TO ANALYZE: "${headline}"
${contextText ? `\nLIVE MARKET CONTEXT:\n${compactText(contextText, 1800)}\n` : ''}${historicalContext}${quantContextText}

Keep the response compact: reasoning under 90 words and evidence up to 4 bullets.

Respond ONLY with valid JSON:
{
  "position": "LONG|SHORT|HEDGE|WAIT",
  "confidence": <integer 0-100>,
  "reasoning": "<your analysis>",
  "evidence": ["<point1>", "<point2>"],
  "scenarios": [{"direction":"LONG|SHORT|HEDGE|WAIT","asset":"<asset>","rationale":"<why>","risk":"LOW|MEDIUM|HIGH"}]
}`;

    try {
        const response = await withAiTimeout(
            withRetry(() => ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: agentPrompt,
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: Type.OBJECT,
                        properties: {
                            position: { type: Type.STRING, enum: ['LONG', 'SHORT', 'HEDGE', 'WAIT'] },
                            confidence: { type: Type.INTEGER },
                            reasoning: { type: Type.STRING },
                            evidence: { type: Type.ARRAY, items: { type: Type.STRING } },
                            scenarios: {
                                type: Type.ARRAY,
                                items: {
                                    type: Type.OBJECT,
                                    properties: {
                                        direction: { type: Type.STRING, enum: ['LONG', 'SHORT', 'HEDGE', 'WAIT'] },
                                        asset: { type: Type.STRING },
                                        rationale: { type: Type.STRING },
                                        risk: { type: Type.STRING, enum: ['LOW', 'MEDIUM', 'HIGH'] },
                                    },
                                    required: ['direction', 'asset', 'rationale', 'risk'],
                                },
                            },
                        },
                        required: ['position', 'confidence', 'reasoning', 'evidence', 'scenarios'],
                    },
                },
            })),
            AI_RUNTIME_CONFIG.warRoomModelTimeoutMs,
            'Backend AI timed out before War Room analysis completed.',
            'model'
        );

        const raw = response.text ?? '';
        const parsed = JSON.parse(raw);

        return {
            data: parsed,
            sources,
            webSearchQueries: queries,
            fromCache: false,
            groundingUsed: useGrounding && sources.length > 0,
            mode: 'live',
            reason,
            notice: joinNotices(notices),
            failureStage: null,
            quantData,
        };
    } catch (error) {
        console.warn(`[Grounding] Agent ${agentId} model degraded:`, error instanceof Error ? error.message : error);
        const failure = classifyAgentModelFailure(error, agentId);
        const contextNotice = joinNotices(notices);
        return {
            data: buildFallbackAgentAnalysis(agentId, headline, promptQuantData, failure.summary),
            sources,
            webSearchQueries: queries,
            fromCache: false,
            groundingUsed: false,
            mode: 'fallback',
            reason: failure.reason,
            notice: [failure.notice, contextNotice].filter(Boolean).join(' '),
            failureStage: failure.failureStage,
            quantData,
        };
    }
}

export function getCacheStats(): { size: number; maxSize: number } {
    return { size: groundingCache.size, maxSize: MAX_CACHE_SIZE };
}
