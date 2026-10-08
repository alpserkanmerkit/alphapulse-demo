import { afterEach, describe, expect, it, vi } from 'vitest';
import { Category, NewsItem, Sentiment } from '../../types';

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('./helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

const sampleNews: NewsItem = {
    id: 'feed-1',
    headline: 'Nvidia expands data center roadmap',
    timestamp: 1,
    category: Category.STOCKS,
    source: 'Wire',
    isAnalyzed: false,
    isAnalysing: false,
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('news query helpers', () => {
    it('requests and falls back to the compact 3-item feed', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
        vi.stubGlobal('fetch', fetchMock);
        const { fetchNewsFromBackend, NEWS_FEED_LIMIT } = await import('../../hooks/queries/useNewsQueries');

        const feed = await fetchNewsFromBackend();

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining(`limit=${NEWS_FEED_LIMIT}`),
            expect.any(Object)
        );
        expect(feed.items).toHaveLength(3);
    });

    it('requests a backend cache bypass for manual force refreshes', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ items: [sampleNews] }),
        });
        vi.stubGlobal('fetch', fetchMock);
        const { fetchNewsFromBackend } = await import('../../hooks/queries/useNewsQueries');

        await fetchNewsFromBackend({ force: true });

        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('refresh=1'),
            expect.any(Object)
        );
    });

    it('keeps failed analysis retryable instead of faking a neutral score', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
        const { analyzeHeadlineBackend } = await import('../../hooks/queries/useNewsQueries');

        const result = await analyzeHeadlineBackend(sampleNews);

        expect(result.isAnalyzed).toBe(false);
        expect(result.analysisError).toContain('Analysis failed');
        expect(result.score).toBeUndefined();
        expect(result.sentiment).toBe(Sentiment.NEUTRAL);
    });

    it('uses the backend score field instead of falling back to a default 50', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                success: true,
                score: 73,
                summary: 'Live summary.',
                sentiment: Sentiment.NEGATIVE,
                affectedAssets: ['NVDA'],
                mode: 'live',
            }),
        }));
        const { analyzeHeadlineBackend } = await import('../../hooks/queries/useNewsQueries');

        const result = await analyzeHeadlineBackend(sampleNews);

        expect(result.score).toBe(73);
        expect(result.sentiment).toBe(Sentiment.NEGATIVE);
    });


    it('preserves remembered analysis across live feed refetches', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    success: true,
                    alphaScore: 82,
                    summary: 'Live summary.',
                    sentiment: Sentiment.POSITIVE,
                    tickers: ['NVDA'],
                    mode: 'live',
                }),
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ items: [sampleNews] }),
            });
        vi.stubGlobal('fetch', fetchMock);
        const { analyzeHeadlineBackend, fetchNewsFromBackend } = await import('../../hooks/queries/useNewsQueries');

        const analyzed = await analyzeHeadlineBackend(sampleNews);
        expect(analyzed.isAnalyzed).toBe(true);

        const feed = await fetchNewsFromBackend();

        expect(feed.items[0].isAnalyzed).toBe(true);
        expect(feed.items[0].score).toBe(82);
        expect(feed.items[0].summary).toBe('Live summary.');
    });
});
