import { GoogleGenAI, Type } from '@google/genai';
import { Sentiment } from '../../types';
import { z } from 'zod';
import { withRetry } from '../../shared/retry';
import { AiRouteReason, withAiTimeout } from './aiRuntime';
import { AI_RUNTIME_CONFIG } from '../../shared/aiConfig';
import { isDemoMode } from '../demo/demoMode';
import { demoAnalyzeHeadline } from '../demo/demoAi';

const MOCK_ASSETS: Record<string, string[]> = {
    bitcoin: ['BTC', 'ETH', 'COIN'],
    apple: ['AAPL', 'SPX'],
    tesla: ['TSLA', 'LIT'],
    oil: ['CL=F', 'XOM', 'CVX'],
    fed: ['SPX', 'ZN=F', 'GC=F'],
    default: ['SPX', 'NDX'],
};

function getMockAnalysis(headline: string) {
    const lower = headline.toLowerCase();
    const isPositive = ['soars', 'record', 'approved', 'beats', 'surge', 'bullish', 'rally'].some((w) => lower.includes(w));
    const isNegative = ['crash', 'plunge', 'miss', 'fall', 'drop', 'ban', 'crisis', 'recession'].some((w) => lower.includes(w));

    let assets = MOCK_ASSETS.default;
    for (const [key, val] of Object.entries(MOCK_ASSETS)) {
        if (lower.includes(key)) { assets = val; break; }
    }

    return {
        score: Math.floor(Math.random() * 40) + 50,
        scoreRationale: 'Mock rationale: System in simulation mode without API key.',
        sentiment: isPositive ? Sentiment.POSITIVE : isNegative ? Sentiment.NEGATIVE : Sentiment.NEUTRAL,
        summary: `Simulated analysis: This financial event has significant market implications based on historical patterns.`,
        affectedAssets: assets,
        isAnalyzed: true,
        isAnalysing: false,
    };
}

export interface AnalysisServiceResult {
    score: number;
    scoreRationale: string;
    sentiment: Sentiment;
    summary: string;
    affectedAssets: string[];
    isAnalyzed: boolean;
    isAnalysing: boolean;
    mode: 'live' | 'simulation' | 'fallback';
    reason: AiRouteReason | null;
    notice?: string;
}

export async function analyzeHeadlineSimple(
    headline: string,
    category: string,
    source: string
): Promise<AnalysisServiceResult> {
    if (isDemoMode()) return demoAnalyzeHeadline(headline);

    if (!process.env.GEMINI_API_KEY) {
        await new Promise((r) => setTimeout(r, 800 + Math.random() * 700));
        return {
            ...getMockAnalysis(headline),
            mode: 'simulation',
            reason: 'ai_simulation',
            notice: 'Backend AI is in simulation mode because GEMINI_API_KEY is missing.',
        };
    }

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        const analysisZodSchema = z.object({
            score: z.number().min(0).max(100),
            scoreRationale: z.string(),
            sentiment: z.enum(['POSITIVE', 'NEGATIVE', 'NEUTRAL']),
            summary: z.string(),
            affectedAssets: z.array(z.string()).max(3),
        });

        const response = await withAiTimeout(
            withRetry(() => ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `Act as a senior trading analyst. Analyze this financial headline:

Headline: "${headline}"
Source: ${source}
Category: ${category}

Return JSON with:
- score (0-100): importance for institutional traders
- scoreRationale: 1 sentence explaining the WHY behind the exact score value
- sentiment: POSITIVE, NEGATIVE, or NEUTRAL
- summary: 2 sentences - fact + market implication
- affectedAssets: up to 3 ticker symbols

Return ONLY valid JSON.`,
                config: {
                    responseMimeType: 'application/json',
                    responseJsonSchema: {
                        type: Type.OBJECT,
                        properties: {
                            score: { type: Type.INTEGER },
                            scoreRationale: { type: Type.STRING },
                            sentiment: { type: Type.STRING, enum: ['POSITIVE', 'NEGATIVE', 'NEUTRAL'] },
                            summary: { type: Type.STRING },
                            affectedAssets: { type: Type.ARRAY, items: { type: Type.STRING } },
                        },
                        required: ['score', 'scoreRationale', 'sentiment', 'summary', 'affectedAssets'],
                    },
                },
            }), 2, 750),
            AI_RUNTIME_CONFIG.headlineAnalysisModelTimeoutMs,
            'Backend AI timed out before headline analysis completed.',
            'model'
        );

        const parsed = JSON.parse(response.text ?? '{}');
        const validated = analysisZodSchema.parse(parsed);

        return {
            ...validated,
            sentiment: validated.sentiment as Sentiment,
            isAnalyzed: true,
            isAnalysing: false,
            mode: 'live',
            reason: null,
        };
    } catch (err) {
        console.warn('[Analysis] Headline model degraded:', err instanceof Error ? err.message : err);
        return {
            ...getMockAnalysis(headline),
            scoreRationale: 'Fallback rationale: live headline model degraded before returning valid structured output.',
            mode: 'fallback',
            reason: 'backend_error',
            notice: 'Live headline analysis degraded; deterministic fallback scoring is shown.',
        };
    }
}
