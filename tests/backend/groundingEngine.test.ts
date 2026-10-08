import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    generateContent: vi.fn(),
    getQuantForecastWithFallback: vi.fn(),
    getCachedNewsSnapshot: vi.fn(),
    modelPrompts: [] as string[],
}));

vi.mock('@google/genai', () => ({
    Type: {
        OBJECT: 'object',
        STRING: 'string',
        INTEGER: 'integer',
        ARRAY: 'array',
    },
    GoogleGenAI: class {
        models = {
            generateContent: mocks.generateContent,
        };
    },
}));

vi.mock('../../server/services/quantForecastService', () => ({
    getQuantForecastWithFallback: mocks.getQuantForecastWithFallback,
}));

vi.mock('../../server/services/rssAggregator', () => ({
    getCachedNewsSnapshot: mocks.getCachedNewsSnapshot,
}));

vi.mock('../../shared/aiConfig', () => ({
    AI_RUNTIME_CONFIG: {
        headlineAnalysisModelTimeoutMs: 9000,
        headlineAnalysisClientTimeoutMs: 11000,
        deepDiveClientTimeoutMs: 30000,
        warRoomModelTimeoutMs: 45000,
        warRoomClientTimeoutMs: 70000,
        warRoomQuantTimeoutMs: 22000,
        warRoomAgentQuantContextTimeoutMs: 25,
        warRoomAgentConcurrency: 2,
    },
}));

import { groundedAgentAnalysis, shouldUseGrounding } from '../../server/services/groundingEngine';

function mockLiveAgentModel() {
    mocks.generateContent.mockImplementation(async (request: { config?: { tools?: unknown }; contents: string }) => {
        if (request.config?.tools) {
            return {
                text: 'grounding unavailable in fixture',
                candidates: [{ groundingMetadata: { groundingChunks: [], webSearchQueries: [] } }],
            };
        }

        mocks.modelPrompts.push(request.contents);
        return {
            text: JSON.stringify({
                position: 'LONG',
                confidence: 72,
                reasoning: 'Live model response.',
                evidence: ['Model fixture'],
                scenarios: [{ direction: 'LONG', asset: 'AAPL', rationale: 'Fixture scenario', risk: 'MEDIUM' }],
            }),
        };
    });
}

describe('shouldUseGrounding', () => {
    beforeEach(() => {
        mocks.generateContent.mockReset();
        mocks.getQuantForecastWithFallback.mockReset();
        mocks.getCachedNewsSnapshot.mockReset();
        mocks.getCachedNewsSnapshot.mockReturnValue([]);
        mocks.modelPrompts.length = 0;
        mockLiveAgentModel();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.GEMINI_API_KEY;
    });

    it('uses grounding for War Room whenever live AI is configured', () => {
        process.env.GEMINI_API_KEY = 'test-key';

        expect(shouldUseGrounding(undefined, 'war-room')).toBe(true);
        expect(shouldUseGrounding(10, 'war-room')).toBe(true);
    });

    it('keeps Deep Dive threshold behavior unchanged', () => {
        process.env.GEMINI_API_KEY = 'test-key';

        expect(shouldUseGrounding(69, 'deep-dive')).toBe(false);
        expect(shouldUseGrounding(70, 'deep-dive')).toBe(true);
    });

    it('does not block live agent analysis on slow quant context', async () => {
        process.env.GEMINI_API_KEY = 'test-key';
        mocks.getCachedNewsSnapshot.mockReturnValue([{
            headline: 'Apple expands AI roadmap',
            source: 'Fixture Wire',
            timestamp: Date.now(),
            url: 'https://example.com/apple-ai-roadmap',
            relatedTickers: ['AAPL'],
        }]);
        mocks.getQuantForecastWithFallback.mockReturnValue(new Promise(() => undefined));

        // Virtual time instead of a wall-clock `< 500 ms` assertion: the analysis must settle once the
        // 25 ms quant budget elapses, even though the quant promise never resolves. Deterministic under CI load.
        vi.useFakeTimers();
        let settled = false;
        const pending = groundedAgentAnalysis(
            'Apple expands AI roadmap',
            'You are the bull agent.',
            'agent-bull',
            80,
            'long',
            'AAPL'
        ).finally(() => {
            settled = true;
        });

        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(true);
        const result = await pending;

        expect(result.mode).toBe('live');
        expect(result.quantData).toBeNull();
        expect(result.reason).toBe('quant_unavailable');
        expect(result.notice).toContain('Quant context timed out after 25ms');
        expect(mocks.modelPrompts[0]).not.toContain('[QUANT ENGINE DATA');
    });

    it('injects live quant context when it arrives inside the agent budget', async () => {
        process.env.GEMINI_API_KEY = 'test-key';
        mocks.getQuantForecastWithFallback.mockResolvedValue({
            isFallback: false,
            reason: null,
            payload: {
                data: {
                    ticker: 'AAPL',
                    current_price: 100,
                    target_12_36_months: 125,
                    model_source: 'quant-engine',
                },
            },
        });

        const result = await groundedAgentAnalysis(
            'Apple expands AI roadmap',
            'You are the bull agent.',
            'agent-bull',
            80,
            'long',
            'AAPL'
        );

        expect(result.quantData).toMatchObject({ ticker: 'AAPL', current_price: 100 });
        expect(result.sources.some((source) => source.uri === 'alphapulse://quant/AAPL/long')).toBe(true);
        expect(result.webSearchQueries).toContain('AlphaPulse Quant Engine');
        expect(mocks.modelPrompts[0]).toContain('[QUANT ENGINE DATA HORIZON: long]');
        expect(mocks.modelPrompts[0]).toContain('Target price: 125');
    });

    it('returns fallback quant data without injecting it as hard prompt context', async () => {
        process.env.GEMINI_API_KEY = 'test-key';
        mocks.getQuantForecastWithFallback.mockResolvedValue({
            isFallback: true,
            reason: 'Quant Engine proxy failed reason=timeout',
            payload: {
                success: true,
                isFallback: true,
                confidence: 0,
                uncertainty: 'EXTREME',
                data: {
                    ticker: 'AAPL',
                    current_price: 99,
                    model_source: 'fallback',
                    is_fallback: true,
                },
            },
        });

        const result = await groundedAgentAnalysis(
            'Apple expands AI roadmap',
            'You are the bull agent.',
            'agent-bull',
            80,
            'long',
            'AAPL'
        );

        expect(result.quantData).toMatchObject({ ticker: 'AAPL', model_source: 'fallback' });
        expect(result.sources.some((source) => source.uri === 'alphapulse://quant/AAPL/long')).toBe(false);
        expect(result.webSearchQueries).not.toContain('AlphaPulse Quant Engine');
        expect(result.notice).toContain('Quant preview returned fallback output');
        expect(mocks.modelPrompts[0]).not.toContain('[QUANT ENGINE DATA');
    });
});
