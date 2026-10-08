import { afterEach, describe, expect, it, vi } from 'vitest';
import { Category, NewsItem, Sentiment } from '../../../types';

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('../helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

// Fixed id so the offline fallback feed can be matched against remembered analysis.
const mockFeedItem: NewsItem = {
    id: 'mock-1',
    headline: 'Mock headline',
    timestamp: 1,
    category: Category.STOCKS,
    source: 'Mock',
    isAnalyzed: false,
    isAnalysing: false,
};
vi.mock('../../../services/marketData', () => ({ generateNewsItem: () => ({ ...mockFeedItem }) }));

// Mutants closed here: q5 (fallback feed merges memory), q13 (tickers kept),
// q14 (feed !ok throws), q15 (analyze !ok throws).
afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('survivors: news query helpers', () => {
    it('treats a non-2xx feed response as offline instead of trusting its body', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 502,
            json: async () => ({ items: [{ ...mockFeedItem, id: 'from-error-body' }] }),
        }));
        const { fetchNewsFromBackend } = await import('../../../hooks/queries/useNewsQueries');

        const feed = await fetchNewsFromBackend();

        expect(feed.mode).toBe('fallback');
        expect(feed.items.map((item) => item.id)).not.toContain('from-error-body');
    });

    it('treats a non-2xx analyze response as a retryable failure instead of an analyzed item', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({ score: 90, summary: 'Should be ignored.', sentiment: Sentiment.POSITIVE }),
        }));
        const { analyzeHeadlineBackend } = await import('../../../hooks/queries/useNewsQueries');

        const result = await analyzeHeadlineBackend(mockFeedItem);

        expect(result.isAnalyzed).toBe(false);
        expect(result.analysisError).toContain('Analysis failed');
        expect(result.score).toBeUndefined();
        expect(result.summary).toBeUndefined();
    });

    it('keeps backend tickers as affectedAssets and defaults to an empty list', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ score: 70, tickers: ['NVDA', 'AMD'] }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ score: 70 }) });
        vi.stubGlobal('fetch', fetchMock);
        const { analyzeHeadlineBackend } = await import('../../../hooks/queries/useNewsQueries');

        expect((await analyzeHeadlineBackend(mockFeedItem)).affectedAssets).toEqual(['NVDA', 'AMD']);
        expect((await analyzeHeadlineBackend(mockFeedItem)).affectedAssets).toEqual([]);
    });

    it('re-applies remembered analysis to the offline fallback feed', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ score: 64, summary: 'Remembered.', sentiment: Sentiment.POSITIVE, mode: 'live' }) })
            .mockRejectedValueOnce(new TypeError('offline'));
        vi.stubGlobal('fetch', fetchMock);
        const { analyzeHeadlineBackend, fetchNewsFromBackend } = await import('../../../hooks/queries/useNewsQueries');

        await analyzeHeadlineBackend(mockFeedItem);
        const feed = await fetchNewsFromBackend();

        expect(feed.mode).toBe('fallback');
        expect(feed.items).toHaveLength(3);
        expect(feed.items.every((item) => item.isAnalyzed && item.score === 64 && item.summary === 'Remembered.')).toBe(true);
    });
});
