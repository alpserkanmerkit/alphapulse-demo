import { describe, expect, it, vi } from 'vitest';

// Pure-helper tests never render icons; skip the ~100 ms lucide-react barrel import.
vi.mock('lucide-react', () => ({ Swords: () => null, CheckCircle: () => null, Clock: () => null, ExternalLink: () => null, Globe: () => null, Send: () => null, BarChart2: () => null }));

import { buildAlignedProjectionPath, inferTickerFromNewsItem, resolveQuantPreviewResult } from '../../../pages/WarRoomPage';
import { Category, NewsItem } from '../../../types';

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('../helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

// Mutants closed here: w11, w12, w13, w14, w17, w18, w19, w23, w24, x6.
function news(overrides: Partial<NewsItem>): NewsItem {
    return {
        id: 'n', headline: 'Neutral market wrap', category: Category.STOCKS, source: 'Wire',
        timestamp: 1, isAnalyzed: false, isAnalysing: false, ...overrides,
    };
}

describe('survivors: buildAlignedProjectionPath', () => {
    it('rounds fractional horizon days to whole days', () => {
        const graph = buildAlignedProjectionPath({ entryPrice: 100, targetPrice: 120, rawPath: [100, 110, 120], horizon: 'long' });

        expect(graph.map((point) => point.day)).toEqual([0, 548, 1095]);
    });

    it('uses the entry-to-target line when the model path has a single point', () => {
        const graph = buildAlignedProjectionPath({ entryPrice: 100, targetPrice: 120, rawPath: [150], horizon: 'short' });

        expect(graph).toEqual([{ day: 0, price: 100 }, { day: 90, price: 120 }]);
    });

    it('returns no path without a usable entry or target price', () => {
        const rawPath = [100, 110, 120];

        expect(buildAlignedProjectionPath({ entryPrice: null, targetPrice: 120, rawPath, horizon: 'short' })).toEqual([]);
        expect(buildAlignedProjectionPath({ entryPrice: 100, targetPrice: null, rawPath, horizon: 'short' })).toEqual([]);
        expect(buildAlignedProjectionPath({ entryPrice: 0, targetPrice: 120, rawPath, horizon: 'short' })).toEqual([]);
    });

    it('anchors a 2D Monte Carlo path start to the entry price when the first median differs', () => {
        const graph = buildAlignedProjectionPath({
            entryPrice: 100,
            targetPrice: 125,
            rawPath: [[103, 104, 105], [110, 111, 112], [120, 121, 122]],
            horizon: 'short',
        });

        // Per-step medians [104, 111, 121] are shifted by -4 at the start and +4 at the end.
        expect(graph).toEqual([{ day: 0, price: 100 }, { day: 45, price: 111 }, { day: 90, price: 125 }]);
    });
});

describe('survivors: resolveQuantPreviewResult', () => {
    const fallbackRoute = { status: 'fallback' as const, data: { ticker: 'AAPL', model_source: 'fallback' }, reason: null };
    const readyRoute = { status: 'ready' as const, data: { ticker: 'AAPL', model_source: 'quant-engine' }, reason: null };
    const errorRoute = { status: 'error' as const, data: null, reason: 'Quant preview failed.' };

    it('prefers ready agent quant data over any route preview', () => {
        const agentReady = { ticker: 'AAPL', current_price: 101, model_source: 'quant-engine' };

        expect(resolveQuantPreviewResult(fallbackRoute, agentReady)).toEqual({ status: 'ready', data: agentReady, reason: null });
        expect(resolveQuantPreviewResult(readyRoute, agentReady).data).toBe(agentReady);
    });

    it('returns the route preview unchanged when the agent sent no quant data', () => {
        expect(resolveQuantPreviewResult(errorRoute, null)).toBe(errorRoute);
        expect(resolveQuantPreviewResult(readyRoute, undefined)).toBe(readyRoute);
    });

    it('marks agent data as fallback by either flag alone', () => {
        expect(resolveQuantPreviewResult(errorRoute, { is_fallback: true, model_source: 'quant-engine' }).status).toBe('fallback');
        expect(resolveQuantPreviewResult(errorRoute, { model_source: 'fallback' }).status).toBe('fallback');
    });
});

describe('survivors: inferTickerFromNewsItem', () => {
    it('reads $TICKER cashtags from a headline with no known company name', () => {
        expect(inferTickerFromNewsItem(news({ headline: 'Short squeeze lifts $GME and $SPCE' }))).toBe('GME');
        expect(inferTickerFromNewsItem(news({ headline: 'Rally in $CL=F futures' }))).toBe('CL=F');
        expect(inferTickerFromNewsItem(news({ headline: 'Neutral market wrap' }))).toBeNull();
    });

    it('prefers explicit relatedTickers over affectedAssets', () => {
        expect(inferTickerFromNewsItem(news({ relatedTickers: ['MSFT'], affectedAssets: ['NVDA'] }))).toBe('MSFT');
    });
});
