import { afterEach, describe, expect, it, vi } from 'vitest';
import { Category, NewsItem } from '../../../types';
import { analyzeHeadlineWithGemini, generateDeepDive } from '../../../services/gemini';

// Mutants closed here: g11 (groundingUsed default), g12 (403 COMPLIANCE_BLOCK branch),
// g13a/g13b (simulation default notices).
const sampleNews: NewsItem = {
    id: 'n1',
    headline: 'Nvidia extends AI infrastructure rally',
    timestamp: 1,
    category: Category.STOCKS,
    source: 'Wire',
    isAnalyzed: false,
    isAnalysing: false,
};

function stubResponse(status: number, body: unknown) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    }));
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('survivors: generateDeepDive', () => {
    it('blocks (without a retry fallback) on a 403 COMPLIANCE_BLOCK response', async () => {
        stubResponse(403, { error: 'COMPLIANCE_BLOCK', message: 'Ticker is restricted.', durationMs: 4 });

        const result = await generateDeepDive('Headline', 'Stocks', ['NVDA'], 80);

        expect(result.blocked).toBe(true);
        expect(result.blockedMessage).toBe('Ticker is restricted.');
        expect(result.notice).toBe('Ticker is restricted.');
        expect(result.reason).toBe('backend_error');
        expect(result.failureStage).toBe('compliance');
        expect(result.durationMs).toBe(4);
        expect(result.mode).toBe('fallback');
        expect(result.groundingUsed).toBe(false);
    });

    it('defaults grounding to unused and sources to empty when the payload omits them', async () => {
        stubResponse(200, { success: true, content: 'Body', scenarios: [] });

        const result = await generateDeepDive('Headline', 'Stocks');

        expect(result.groundingUsed).toBe(false);
        expect(result.groundingSources).toEqual([]);
        expect(result.mode).toBe('live');
        expect(result.notice).toBeUndefined();
    });

    it('explains simulation output when the backend sends no notice', async () => {
        stubResponse(200, { success: true, mode: 'simulation', content: 'Body' });

        const result = await generateDeepDive('Headline', 'Stocks');

        expect(result.notice).toBe('Deep Dive is using backend simulation output.');
    });
});

describe('survivors: analyzeHeadlineWithGemini', () => {
    it('explains missing GEMINI_API_KEY when simulation mode comes without a notice', async () => {
        stubResponse(200, { success: true, mode: 'simulation', score: 60 });

        const result = await analyzeHeadlineWithGemini(sampleNews);

        expect(result.notice).toBe('Backend AI is in simulation mode because GEMINI_API_KEY is missing.');
        expect(result.item.analysisNotice).toBe(result.notice);
    });
});
