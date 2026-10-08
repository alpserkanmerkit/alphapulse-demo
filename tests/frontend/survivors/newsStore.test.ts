import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Category, NewsItem, RuntimeStatusResponse } from '../../../types';

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('../helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

const analyzeHeadlineWithGemini = vi.fn();
const fetchNewsFromX = vi.fn();
const generateDeepDive = vi.fn();
const fetchRuntimeStatus = vi.fn();
const generateNewsItem = vi.fn();

vi.mock('../../../services/gemini', () => ({ analyzeHeadlineWithGemini, fetchNewsFromX, generateDeepDive }));
vi.mock('../../../services/runtime', () => ({ fetchRuntimeStatus }));
vi.mock('../../../services/marketData', () => ({ generateNewsItem }));

// Mutants closed here: n10 (lastAnalysisNotice), n11 (isFetchingX guard),
// n12 (refreshRuntimeStatus isSimulation), n13 (5 backend items).
function runtime(ai: 'live' | 'simulation'): RuntimeStatusResponse {
    return {
        status: 'ok',
        version: '2.0.0',
        mode: 'live',
        services: { ai, quant: 'reachable', compliance: 'ready' },
        diagnostics: {
            quant: { reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            compliance: { source: 'local-file', reason: null, loadedAt: '2026-04-18T12:00:00.000Z' },
        },
        timestamp: '2026-04-18T12:00:00.000Z',
    };
}

function createNews(id: string): NewsItem {
    return {
        id,
        headline: `Headline ${id}`,
        timestamp: Number(id),
        category: Category.STOCKS,
        source: 'Wire',
        isAnalyzed: false,
        isAnalysing: false,
    };
}

function backendFeed(items: NewsItem[]) {
    return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items }) });
}

describe('survivors: newsStore', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        analyzeHeadlineWithGemini.mockReset();
        fetchNewsFromX.mockReset();
        fetchRuntimeStatus.mockReset();
        generateNewsItem.mockReset();
        analyzeHeadlineWithGemini.mockImplementation(async (item: NewsItem) => ({
            item: { ...item, isAnalyzed: true, isAnalysing: false },
            mode: 'live' as const,
        }));
    });

    it('stores the analysis notice and surfaces it in the runtime view; clears it when absent', async () => {
        const item = createNews('1');
        analyzeHeadlineWithGemini.mockResolvedValueOnce({
            item: { ...item, isAnalyzed: true },
            mode: 'fallback',
            notice: 'Local analysis in use.',
        });
        const { useNewsStore } = await import('../../../stores/newsStore');
        useNewsStore.setState({ news: [item] });

        await useNewsStore.getState().processItem(item);

        expect(useNewsStore.getState().lastAnalysisNotice).toBe('Local analysis in use.');
        expect(useNewsStore.getState().runtimeView.notices).toContain('Local analysis in use.');

        await useNewsStore.getState().processItem(item);

        expect(useNewsStore.getState().lastAnalysisNotice).toBeNull();
    });

    it('derives isSimulation from the runtime AI mode and keeps the analysis mode when status is unavailable', async () => {
        const { useNewsStore } = await import('../../../stores/newsStore');

        fetchRuntimeStatus.mockResolvedValueOnce(runtime('live'));
        await useNewsStore.getState().refreshRuntimeStatus();
        expect(useNewsStore.getState().isSimulation).toBe(false);
        expect(useNewsStore.getState().analysisMode).toBe('live');

        fetchRuntimeStatus.mockResolvedValueOnce(runtime('simulation'));
        await useNewsStore.getState().refreshRuntimeStatus();
        expect(useNewsStore.getState().isSimulation).toBe(true);
        expect(useNewsStore.getState().analysisMode).toBe('simulation');

        useNewsStore.setState({ analysisMode: 'live' });
        fetchRuntimeStatus.mockResolvedValueOnce(null);
        await useNewsStore.getState().refreshRuntimeStatus();
        expect(useNewsStore.getState().isSimulation).toBe(true);
        expect(useNewsStore.getState().analysisMode).toBe('live');
    });

    it('ignores a second X fetch while one is running and releases the guard afterwards', async () => {
        let release: (value: unknown) => void = () => undefined;
        // Only the first call hangs; a second (unguarded) call would resolve an empty feed instead of hanging the test.
        const fetchMock = vi.fn()
            .mockReturnValueOnce(new Promise((resolve) => { release = resolve; }))
            .mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
        vi.stubGlobal('fetch', fetchMock);
        const { useNewsStore } = await import('../../../stores/newsStore');

        const first = useNewsStore.getState().handleFetchFromX();
        expect(useNewsStore.getState().isFetchingX).toBe(true);
        await useNewsStore.getState().handleFetchFromX();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        release({ ok: true, json: async () => ({ items: [createNews('5')] }) });
        await first;

        expect(useNewsStore.getState().isFetchingX).toBe(false);
        expect(analyzeHeadlineWithGemini).toHaveBeenCalledTimes(1);
    });

    it('analyzes at most the first five backend items on a manual fetch and keeps all of them listed', async () => {
        const items = ['1', '2', '3', '4', '5', '6', '7'].map((id) => createNews(id));
        vi.stubGlobal('fetch', backendFeed(items));
        const { useNewsStore } = await import('../../../stores/newsStore');

        await useNewsStore.getState().handleFetchFromX();

        expect(analyzeHeadlineWithGemini.mock.calls.map(([item]) => item.id)).toEqual(['1', '2', '3', '4', '5']);
        expect(useNewsStore.getState().news).toHaveLength(7);
        expect(useNewsStore.getState().feedMode).toBe('live');
    });
});
