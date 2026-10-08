import { describe, expect, it, vi } from 'vitest';

// Pure-helper tests never render icons; skip the ~100 ms lucide-react barrel import.
vi.mock('lucide-react', () => ({ Swords: () => null, CheckCircle: () => null, Clock: () => null, ExternalLink: () => null, Globe: () => null, Send: () => null, BarChart2: () => null }));

import { buildAlignedProjectionPath, deriveRepresentativePath, getHorizonDayCount, inferTickerFromNewsItem, resolveQuantPreviewResult } from '../../pages/WarRoomPage';
import { Category } from '../../types';

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('./helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

describe('War Room projection helpers', () => {
    it('derives a time-step median path from 2D Monte Carlo trajectories', () => {
        const path = deriveRepresentativePath([
            [90, 100, 120],
            [95, 110, 125],
            [80, 202, 320],
        ]);

        expect(path).toEqual([100, 110, 202]);
        // Rows are sorted per step and even-length rows average the two middle values.
        expect(deriveRepresentativePath([[3, 1, 2], [120, 90, 100, 110]])).toEqual([2, 105]);
    });

    it('anchors a conflicting Monte Carlo sample path to the aggregate median target', () => {
        const graph = buildAlignedProjectionPath({
            entryPrice: 273.55,
            targetPrice: 318.23,
            rawPath: [
                [250, 273.55, 290],
                [230, 260, 310],
                [180, 202, 360],
            ],
            horizon: 'short',
        });

        // Per-step medians are [273.55, 260, 202]; the end is re-anchored to the target (318.23).
        expect(graph).toHaveLength(3);
        expect(graph[0]).toEqual({ day: 0, price: 273.55 });
        expect(graph[1].day).toBe(45);
        expect(graph[1].price).toBeCloseTo(318.115, 1);
        expect(graph[2]).toEqual({ day: getHorizonDayCount('short'), price: 318.23 });
        expect(getHorizonDayCount('short')).toBe(90);
        expect(graph.map((point) => point.price)).not.toContain(202);
    });

    it('aligns a 1D medium or long horizon path to the explicit target field', () => {
        const graph = buildAlignedProjectionPath({
            entryPrice: 100,
            targetPrice: 118,
            rawPath: [98, 101, 107, 112],
            horizon: 'medium',
        });

        // Raw 1D path [98, 101, 107, 112] is shifted so it starts at the entry (100) and ends at the target (118).
        expect(graph).toEqual([
            { day: 0, price: 100 },
            { day: 60, price: 104.33 },
            { day: 120, price: 111.67 },
            { day: 180, price: 118 },
        ]);
        expect(getHorizonDayCount('medium')).toBe(180);
        expect(getHorizonDayCount('long')).toBe(1095);
    });

    it('falls back to an entry-to-target line when model path data is empty', () => {
        const graph = buildAlignedProjectionPath({
            entryPrice: 100,
            targetPrice: 135,
            rawPath: [],
            horizon: 'long',
        });

        expect(graph).toEqual([
            { day: 0, price: 100 },
            { day: getHorizonDayCount('long'), price: 135 },
        ]);
    });
});

describe('resolveQuantPreviewResult', () => {
    it('prefers a live route preview over fallback quant data returned by an agent', () => {
        const routePreview = {
            status: 'ready' as const,
            data: { ticker: 'AAPL', current_price: 100, model_source: 'quant-engine' },
            reason: null,
        };
        const agentFallback = { ticker: 'AAPL', current_price: 99, model_source: 'fallback', is_fallback: true };

        expect(resolveQuantPreviewResult(routePreview, agentFallback)).toBe(routePreview);
    });

    it('uses agent fallback quant data when the route preview fails', () => {
        const routePreview = {
            status: 'error' as const,
            data: null,
            reason: 'Quant preview failed.',
        };
        const agentFallback = { ticker: 'AAPL', current_price: 99, model_source: 'fallback', is_fallback: true };

        const result = resolveQuantPreviewResult(routePreview, agentFallback);

        expect(result.status).toBe('fallback');
        expect(result.data).toBe(agentFallback);
    });
});

describe('inferTickerFromNewsItem', () => {
    it('maps uppercase company words instead of treating them as malformed tickers', () => {
        expect(inferTickerFromNewsItem({
            id: 'n1',
            headline: 'APPLE expands AI roadmap',
            category: Category.STOCKS,
            source: 'Wire',
            timestamp: 1,
            isAnalyzed: false,
            isAnalysing: false,
        })).toBe('AAPL');
        expect(inferTickerFromNewsItem({
            id: 'n1b',
            headline: 'Large cap tech outlook',
            category: Category.STOCKS,
            source: 'Wire',
            timestamp: 1,
            affectedAssets: ['APPLE'],
            isAnalyzed: false,
            isAnalysing: false,
        })).toBe('AAPL');
    });

    it('ignores invalid explicit assets and falls back to known headline entities', () => {
        expect(inferTickerFromNewsItem({
            id: 'n2',
            headline: 'Nvidia demand lifts chip suppliers',
            category: Category.STOCKS,
            source: 'Wire',
            timestamp: 1,
            affectedAssets: ['large cap semiconductors'],
            isAnalyzed: false,
            isAnalysing: false,
        })).toBe('NVDA');
    });
});
