import { afterEach, describe, expect, it, vi } from 'vitest';
import { Category, NewsItem } from '../../types';
import { analyzeHeadlineWithGemini, generateDeepDive } from '../../services/gemini';

const sampleNews: NewsItem = {
    id: 'n1',
    headline: 'Nvidia extends AI infrastructure rally',
    timestamp: Date.now(),
    category: Category.STOCKS,
    source: 'Wire',
    isAnalyzed: false,
    isAnalysing: false,
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('services/gemini', () => {
    it('returns a blocked result when compliance coverage is unavailable', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 503,
            json: async () => ({
                reason: 'compliance_unavailable',
                notice: 'Compliance coverage is temporarily unavailable. AI analysis is paused until the dataset is restored.',
                durationMs: 3,
                failureStage: 'compliance',
            }),
        }));

        const result = await analyzeHeadlineWithGemini(sampleNews);

        expect(result.blocked).toBe(true);
        expect(result.reason).toBe('compliance_unavailable');
        expect(result.failureStage).toBe('compliance');
        expect(result.item.isAnalyzed).toBe(false);
        expect(result.notice).toContain('Compliance coverage is temporarily unavailable');
    });

    it('passes through simulation mode and telemetry on successful analysis', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                success: true,
                mode: 'simulation',
                reason: 'ai_simulation',
                notice: 'Backend AI is in simulation mode because GEMINI_API_KEY is missing.',
                durationMs: 12,
                failureStage: null,
                score: 77,
                scoreRationale: 'Simulation rationale.',
                sentiment: 'POSITIVE',
                summary: 'Simulated summary.',
                affectedAssets: ['NVDA'],
            }),
        }));

        const result = await analyzeHeadlineWithGemini(sampleNews);

        expect(result.mode).toBe('simulation');
        expect(result.reason).toBe('ai_simulation');
        expect(result.durationMs).toBe(12);
        expect(result.failureStage).toBeNull();
        expect(result.item.analysisMode).toBe('simulation');
    });

    it('maps network failures to backend_unreachable fallback analysis', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network offline')));

        const result = await analyzeHeadlineWithGemini(sampleNews);

        expect(result.mode).toBe('fallback');
        expect(result.reason).toBe('backend_unreachable');
        expect(result.notice).toContain('temporarily unavailable');
        expect(result.item.analysisMode).toBe('fallback');
    });

    it('maps abort errors to backend_timeout deep-dive fallback', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Timeout', 'AbortError')));

        const result = await generateDeepDive(sampleNews.headline, sampleNews.category, ['NVDA'], 88);

        expect(result.mode).toBe('fallback');
        expect(result.reason).toBe('backend_timeout');
        expect(result.notice).toContain('took too long');
    });
});
