import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Category, NewsItem, RuntimeStatusResponse } from '../../types';

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('./helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

const analyzeHeadlineWithGemini = vi.fn();
const fetchNewsFromX = vi.fn();
const generateDeepDive = vi.fn();
const fetchRuntimeStatus = vi.fn();
const generateNewsItem = vi.fn();

vi.mock('../../services/gemini', () => ({
    analyzeHeadlineWithGemini,
    fetchNewsFromX,
    generateDeepDive,
}));

vi.mock('../../services/runtime', () => ({
    fetchRuntimeStatus,
}));

vi.mock('../../services/marketData', () => ({
    generateNewsItem,
}));

const runtimeStatus: RuntimeStatusResponse = {
    status: 'ok',
    version: '2.0.0',
    mode: 'live',
    services: {
        ai: 'live',
        quant: 'reachable',
        compliance: 'ready',
    },
    diagnostics: {
        quant: {
            reason: null,
            checkedAt: '2026-04-18T12:00:00.000Z',
        },
        compliance: {
            source: 'local-file',
            reason: null,
            loadedAt: '2026-04-18T12:00:00.000Z',
        },
    },
    timestamp: '2026-04-18T12:00:00.000Z',
};

function createNews(id: string, headline = `Headline ${id}`): NewsItem {
    return {
        id,
        headline,
        timestamp: Number(id),
        category: Category.STOCKS,
        source: 'Wire',
        isAnalyzed: false,
        isAnalysing: false,
    };
}

describe('newsStore', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        analyzeHeadlineWithGemini.mockReset();
        fetchNewsFromX.mockReset();
        generateDeepDive.mockReset();
        fetchRuntimeStatus.mockReset();
        generateNewsItem.mockReset();
    });

    it('seeds backend news and analyzes the first three items sequentially', async () => {
        const backendItems = [createNews('1'), createNews('2'), createNews('3'), createNews('4')];
        const order: string[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        fetchRuntimeStatus.mockResolvedValue(runtimeStatus);
        analyzeHeadlineWithGemini.mockImplementation(async (item: NewsItem) => {
            order.push(item.id);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return {
                item: { ...item, isAnalyzed: true, isAnalysing: false, analysisMode: 'live' as const },
                mode: 'live' as const,
            };
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ items: backendItems }),
        }));

        const { useNewsStore } = await import('../../stores/newsStore');
        await useNewsStore.getState().seedInitialData();

        expect(useNewsStore.getState().news).toHaveLength(4);
        expect(useNewsStore.getState().feedMode).toBe('live');
        expect(order).toEqual(['1', '2', '3']);
        expect(maxInFlight).toBe(1);
    });

    it('falls back to local X news when backend feed is empty', async () => {
        const fallbackItems = [createNews('11', 'Fallback 1'), createNews('12', 'Fallback 2')];
        fetchRuntimeStatus.mockResolvedValue(runtimeStatus);
        fetchNewsFromX.mockResolvedValue(fallbackItems);
        analyzeHeadlineWithGemini.mockImplementation(async (item: NewsItem) => ({
            item: { ...item, isAnalyzed: true, isAnalysing: false, analysisMode: 'fallback' as const },
            mode: 'fallback' as const,
        }));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ items: [] }),
        }));

        const { useNewsStore } = await import('../../stores/newsStore');
        await useNewsStore.getState().handleFetchFromX();

        expect(useNewsStore.getState().feedMode).toBe('fallback');
        expect(useNewsStore.getState().news.map((item) => item.id)).toEqual(['11', '12']);
        expect(analyzeHeadlineWithGemini).toHaveBeenCalledTimes(2);
    });

    it('keeps the previous live analysis mode when compliance blocks analysis', async () => {
        const item = createNews('21');
        fetchRuntimeStatus.mockResolvedValue(runtimeStatus);
        analyzeHeadlineWithGemini.mockResolvedValue({
            item: { ...item, isAnalyzed: false, isAnalysing: false, analysisNotice: 'Compliance coverage is temporarily unavailable.' },
            mode: 'fallback',
            reason: 'compliance_unavailable',
            notice: 'Compliance coverage is temporarily unavailable.',
            blocked: true,
        });

        const { useNewsStore } = await import('../../stores/newsStore');
        useNewsStore.setState({
            news: [item],
            analysisMode: 'live',
            feedMode: 'live',
            isSimulation: false,
            runtimeStatus,
            runtimeView: useNewsStore.getState().runtimeView,
        });

        await useNewsStore.getState().processItem(item);

        expect(useNewsStore.getState().analysisMode).toBe('live');
        expect(useNewsStore.getState().isSimulation).toBe(false);
        expect(useNewsStore.getState().news[0].analysisNotice).toContain('Compliance coverage is temporarily unavailable');
    });
});
