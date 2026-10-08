/* eslint-disable @typescript-eslint/no-explicit-any */
import { AiFailureStage, AiRouteTelemetry, Category, DataMode, DeepDiveResponse, NewsItem, Sentiment } from "../types";
import { AI_RUNTIME_CONFIG } from "../shared/aiConfig";
import { apiFetch } from "../utils/apiClient";

export type AiRouteReason =
  | 'backend_unreachable'
  | 'backend_timeout'
  | 'backend_error'
  | 'compliance_unavailable'
  | 'ai_simulation'
  | 'grounding_unavailable'
  | 'quant_unavailable';

interface BackendErrorShape {
  success?: boolean;
  error?: string;
  reason?: AiRouteReason;
  notice?: string;
  message?: string;
  durationMs?: number;
  failureStage?: AiFailureStage | null;
}

interface BackendDeepDivePayload extends BackendErrorShape {
  content?: string;
  scenarios?: DeepDiveResponse['scenarios'];
  mode?: DataMode;
  sources?: { title: string; uri: string }[];
  groundingUsed?: boolean;
}

// Fallback mock analysis
const generateMockAnalysis = (headline: string): Partial<NewsItem> => {
  const isCrypto = headline.toLowerCase().includes("bitcoin") || headline.toLowerCase().includes("ethereum");
  const isPositive = headline.toLowerCase().includes("soars") || headline.toLowerCase().includes("record") || headline.toLowerCase().includes("approved");

  return {
    score: Math.floor(Math.random() * 40) + 50,
    scoreRationale: "Simulated rationale: System network fallback, assigning base simulated score.",
    sentiment: isPositive ? Sentiment.POSITIVE : Sentiment.NEGATIVE,
    summary: "Simulated Analysis: This event has significant market implications based on basic historical patterns. Immediate liquidity checks recommended.",
    affectedAssets: isCrypto ? ["BTC", "ETH"] : ["SPX", "NDX"],
    isAnalyzed: true,
    isAnalysing: false,
  };
};

const MOCK_DEEP_DIVE_RESPONSE: DeepDiveResponse = {
  content: `**1. The Event (What)**\nSimulation mode activated. Market exhibits volatility.\n**2. Context (Background)**\nHistorical data suggests a shift.\n**3. Chain Impact (Ripple Effects)**\nCross-asset rotation likely.\n**4. Forecast (Outlook)**\nExpect further consolidation before breakout.`,
  scenarios: [
    { direction: "LONG", asset: "Safe Havens", rationale: "Uncertainty premium.", risk: "LOW" },
    { direction: "HEDGE", asset: "Volatility Index", rationale: "Erratic price action.", risk: "HIGH" }
  ]
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function classifyRequestFailure(error: unknown): { reason: AiRouteReason; notice: string } {
  if (isAbortError(error)) {
    return {
      reason: 'backend_timeout',
      notice: 'Backend AI timed out; using local fallback output.',
    };
  }

  if (error instanceof TypeError) {
    return {
      reason: 'backend_unreachable',
      notice: 'Backend unreachable; using local fallback output.',
    };
  }

  return {
    reason: 'backend_error',
    notice: 'Backend AI request failed; using local fallback output.',
  };
}

function buildAnalysisFallbackNotice(reason: AiRouteReason, backendNotice?: string): string {
  if (reason === 'compliance_unavailable') {
    return backendNotice ?? 'Compliance coverage is temporarily unavailable. Live analysis is paused until the dataset is restored.';
  }

  if (reason === 'backend_timeout') {
    return 'Live analysis took too long; showing local fallback analysis.';
  }

  if (reason === 'backend_unreachable') {
    return 'Live analysis is temporarily unavailable; showing local fallback analysis.';
  }

  return backendNotice ?? 'Live analysis is temporarily limited; showing local fallback analysis.';
}

function buildDeepDiveFallbackNotice(reason: AiRouteReason, backendNotice?: string): string {
  if (reason === 'compliance_unavailable') {
    return backendNotice ?? 'Compliance coverage is temporarily unavailable. Deep Dive is paused until the dataset is restored.';
  }

  if (reason === 'backend_timeout') {
    return 'Live Deep Dive took too long; showing local fallback Deep Dive.';
  }

  if (reason === 'backend_unreachable') {
    return 'Live Deep Dive is temporarily unavailable; showing local fallback Deep Dive.';
  }

  return backendNotice ?? 'Live Deep Dive is temporarily limited; showing local fallback Deep Dive.';
}

async function readJson<T>(response: Response): Promise<T | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function createBackendFailure(payload: BackendErrorShape | null, fallbackNotice: string): Error & { reason: AiRouteReason; notice: string } {
  const error = new Error(payload?.error ?? fallbackNotice) as Error & { reason: AiRouteReason; notice: string };
  error.reason = payload?.reason ?? 'backend_error';
  error.notice = payload?.notice ?? fallbackNotice;
  return error;
}

export interface AnalyzeHeadlineResult extends AiRouteTelemetry {
  item: NewsItem;
  mode: DataMode;
  notice?: string;
  reason?: AiRouteReason;
  blocked?: boolean;
}

export interface DeepDiveResult extends AiRouteTelemetry {
  response: DeepDiveResponse;
  mode: DataMode;
  notice?: string;
  reason?: AiRouteReason;
  groundingSources: { title: string; uri: string }[];
  groundingUsed: boolean;
  blocked?: boolean;
  blockedMessage?: string;
}

export const analyzeHeadlineWithGemini = async (newsItem: NewsItem): Promise<AnalyzeHeadlineResult> => {
  try {
    const res = await apiFetch('/api/ai/analyze', {
      method: 'POST',
      body: JSON.stringify({
        headline: newsItem.headline,
        category: newsItem.category,
        source: newsItem.source
      }),
      signal: AbortSignal.timeout(AI_RUNTIME_CONFIG.headlineAnalysisClientTimeoutMs)
    });

    const data = await readJson<BackendErrorShape & Record<string, any>>(res);

    if (!res.ok) {
      if (res.status === 503 && (data?.reason === 'compliance_unavailable' || data?.error === 'COMPLIANCE_DATA_UNAVAILABLE')) {
        const notice = buildAnalysisFallbackNotice('compliance_unavailable', data.notice ?? data.message);
        return {
          item: {
            ...newsItem,
            isAnalyzed: false,
            isAnalysing: false,
            analysisNotice: notice,
          },
          mode: 'fallback',
          notice,
          reason: 'compliance_unavailable',
          blocked: true,
          durationMs: data?.durationMs,
          failureStage: data?.failureStage ?? 'compliance',
        };
      }

      throw createBackendFailure(data, 'Backend AI request failed.');
    }

    if (data?.success) {
      const mode = (data.mode ?? 'live') as DataMode;
      const notice = data.notice ?? (mode === 'simulation' ? 'Backend AI is in simulation mode because GEMINI_API_KEY is missing.' : undefined);

        return {
          item: {
            ...newsItem,
          score: data.score,
          scoreRationale: data.scoreRationale,
          sentiment: data.sentiment as Sentiment,
          summary: data.summary,
          affectedAssets: data.affectedAssets,
          analysisMode: mode,
          analysisNotice: notice,
          isAnalyzed: true,
          isAnalysing: false
          },
          mode,
          notice,
          reason: data.reason,
          durationMs: data.durationMs,
          failureStage: data.failureStage ?? null,
        };
      }

    throw createBackendFailure(data, 'Backend AI request failed.');
  } catch (error) {
    console.error("Backend Analysis Failed:", error);
    const failure = 'reason' in (error as object) && 'notice' in (error as object)
      ? { reason: (error as { reason: AiRouteReason }).reason, notice: (error as { notice: string }).notice }
      : classifyRequestFailure(error);
    const notice = buildAnalysisFallbackNotice(failure.reason, failure.notice);

    return {
      item: {
        ...newsItem,
        ...generateMockAnalysis(newsItem.headline),
        analysisMode: 'fallback',
        analysisNotice: notice,
      },
      mode: 'fallback',
      notice,
      reason: failure.reason,
      failureStage: 'unknown',
    };
  }
};

export const generateDeepDive = async (
  headline: string,
  category: string,
  tickers: string[] = [],
  alphaScore = 85
): Promise<DeepDiveResult> => {
  try {
    const res = await apiFetch('/api/ai/deep-dive', {
      method: 'POST',
      body: JSON.stringify({
        headline,
        category,
        tickers,
        alphaScore
      }),
      signal: AbortSignal.timeout(AI_RUNTIME_CONFIG.deepDiveClientTimeoutMs)
    });

    const data = await readJson<BackendDeepDivePayload>(res);

    if (!res.ok) {
      if (res.status === 503 && (data?.reason === 'compliance_unavailable' || data?.error === 'COMPLIANCE_DATA_UNAVAILABLE')) {
        return {
          response: MOCK_DEEP_DIVE_RESPONSE,
          mode: 'fallback',
          notice: buildDeepDiveFallbackNotice('compliance_unavailable', data.notice ?? data.message),
          reason: 'compliance_unavailable',
          groundingSources: [],
          groundingUsed: false,
          blocked: true,
          blockedMessage: data.notice ?? data.message,
          durationMs: data.durationMs,
          failureStage: data.failureStage ?? 'compliance',
        };
      }

      if (res.status === 403 && data?.error === 'COMPLIANCE_BLOCK') {
        return {
          response: MOCK_DEEP_DIVE_RESPONSE,
          mode: 'fallback',
          notice: data.message,
          reason: 'backend_error',
          groundingSources: [],
          groundingUsed: false,
          blocked: true,
          blockedMessage: data.message,
          durationMs: data.durationMs,
          failureStage: data.failureStage ?? 'compliance',
        };
      }

      throw createBackendFailure(data, 'Backend Deep Dive request failed.');
    }

    if (data?.success) {
      const mode = (data.mode ?? 'live') as DataMode;
      return {
        response: {
          content: data.content ?? MOCK_DEEP_DIVE_RESPONSE.content,
          scenarios: data.scenarios ?? MOCK_DEEP_DIVE_RESPONSE.scenarios
        },
        mode,
        notice: data.notice ?? (mode === 'simulation' ? 'Deep Dive is using backend simulation output.' : undefined),
        reason: data.reason,
        groundingSources: data.sources ?? [],
        groundingUsed: data.groundingUsed ?? false,
        durationMs: data.durationMs,
        failureStage: data.failureStage ?? null,
      };
    }

    throw createBackendFailure(data, 'Backend Deep Dive request failed.');
  } catch (error) {
    console.error("Backend Deep Dive Failed:", error);
    const failure = 'reason' in (error as object) && 'notice' in (error as object)
      ? { reason: (error as { reason: AiRouteReason }).reason, notice: (error as { notice: string }).notice }
      : classifyRequestFailure(error);
    const notice = buildDeepDiveFallbackNotice(failure.reason, failure.notice);

    return {
      response: MOCK_DEEP_DIVE_RESPONSE,
      mode: 'fallback',
      notice,
      reason: failure.reason,
      groundingSources: [],
      groundingUsed: false,
      failureStage: 'unknown',
    };
  }
};

export const fetchNewsFromX = async (): Promise<NewsItem[]> => {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return [
    {
      id: Date.now().toString() + "-x1",
      headline: "Simulation: Elon Musk tweets about integration, market spikes 15%.",
      timestamp: Date.now(),
      category: Category.CRYPTO,
      source: "X (Twitter)",
      isAnalyzed: false,
      isAnalysing: false,
    },
    {
      id: Date.now().toString() + "-x2",
      headline: "Simulation: Major tech CEO hints at new release on X.",
      timestamp: Date.now(),
      category: Category.STARTUP,
      source: "X (Twitter)",
      isAnalyzed: false,
      isAnalysing: false,
    },
  ];
};

export const createChatSession = (): any => {
  return { proxy: true };
};

export const sendChatMessage = async (chat: any, message: string): Promise<string> => {
  try {
    const res = await apiFetch('/api/ai/chat', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: message }] }),
        signal: AbortSignal.timeout(30000),
    });
    const data = await readJson<BackendErrorShape & { text?: string }>(res);
    if (!res.ok) {
      return data?.notice ?? "Error connecting to AlphaPulse Orchestrator. Please try again.";
    }
    return data?.text || "No response received from AlphaPulse Brain.";
  } catch (error) {
    console.error("Chat Error:", error);
    return classifyRequestFailure(error).notice;
  }
};
