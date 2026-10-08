/* eslint-disable @typescript-eslint/no-explicit-any */
import { create } from 'zustand';
import { Category, DataMode, NewsItem, RuntimeStatusResponse, RuntimeViewState } from '../types';
import { generateNewsItem } from '../services/marketData';
import { analyzeHeadlineWithGemini, fetchNewsFromX, generateDeepDive } from '../services/gemini';
import { fetchRuntimeStatus } from '../services/runtime';
import { buildRuntimeView } from '../services/runtimeView';
import { apiFetch } from '../utils/apiClient';

interface BackendNewsResult {
    items: NewsItem[];
    mode: DataMode;
}

async function processItemsSequentially(
    items: NewsItem[],
    processor: (item: NewsItem) => Promise<void>
): Promise<void> {
    for (const item of items) {
        await processor(item);
    }
}

async function fetchNewsFromBackend(): Promise<BackendNewsResult> {
    try {
        const response = await apiFetch('/api/news/feed', { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Backend ${response.status}`);

        const json = await response.json();
        return {
            mode: 'live',
            items: (json.items ?? []).map((item: Partial<NewsItem>) => ({
                ...item,
                isAnalyzed: false,
                isAnalysing: false,
            })) as NewsItem[],
        };
    } catch {
        console.warn('[NewsStore] Backend unavailable, feed will fall back to local data');
        return { items: [], mode: 'fallback' };
    }
}

interface NewsState {
    news: NewsItem[];
    activeCategory: Category;
    isStreamActive: boolean;
    isFetchingX: boolean;
    isSimulation: boolean;
    feedMode: DataMode;
    analysisMode: DataMode;
    lastAnalysisNotice: string | null;
    runtimeStatus: RuntimeStatusResponse | null;
    runtimeView: RuntimeViewState;

    setActiveCategory: (category: Category) => void;
    setNewsItems: (items: NewsItem[], mode?: DataMode) => void;
    toggleStream: () => void;
    addNewsItem: (item: NewsItem) => void;
    updateNewsItem: (id: string, updates: Partial<NewsItem>) => void;
    refreshRuntimeStatus: () => Promise<RuntimeStatusResponse | null>;
    processItem: (item: NewsItem) => Promise<void>;
    handleDeepDive: (id: string) => Promise<void>;
    handleManualAdd: (headline: string) => void;
    handleFetchFromX: () => Promise<void>;
    seedInitialData: () => Promise<void>;
    filteredNews: () => NewsItem[];
}

const DEFAULT_FEED_MODE: DataMode = 'fallback';
const DEFAULT_ANALYSIS_MODE: DataMode = 'fallback';

export const useNewsStore = create<NewsState>((set, get) => ({
    news: [],
    activeCategory: Category.ALL,
    isStreamActive: true,
    isFetchingX: false,
    isSimulation: false,
    feedMode: DEFAULT_FEED_MODE,
    analysisMode: DEFAULT_ANALYSIS_MODE,
    lastAnalysisNotice: null,
    runtimeStatus: null,
    runtimeView: buildRuntimeView(null, DEFAULT_FEED_MODE, DEFAULT_ANALYSIS_MODE),

    setActiveCategory: (category) => set({ activeCategory: category }),

    setNewsItems: (items, mode = 'live') => set((state) => ({
        news: items,
        feedMode: mode,
        runtimeView: buildRuntimeView(state.runtimeStatus, mode, state.analysisMode, state.lastAnalysisNotice),
    })),

    toggleStream: () => set((state) => ({ isStreamActive: !state.isStreamActive })),

    addNewsItem: (item) => set((state) => ({ news: [item, ...state.news].slice(0, 50) })),

    updateNewsItem: (id, updates) =>
        set((state) => ({
            news: state.news.map((newsItem) => newsItem.id === id ? { ...newsItem, ...updates } : newsItem),
        })),

    refreshRuntimeStatus: async () => {
        const runtimeStatus = await fetchRuntimeStatus();
        const aiMode = runtimeStatus?.services.ai ?? 'simulation';
        const nextAnalysisMode = runtimeStatus ? aiMode : get().analysisMode;

        set((state) => ({
            runtimeStatus,
            isSimulation: aiMode !== 'live',
            analysisMode: nextAnalysisMode,
            runtimeView: buildRuntimeView(runtimeStatus, state.feedMode, nextAnalysisMode, state.lastAnalysisNotice),
        }));

        return runtimeStatus;
    },

    processItem: async (item) => {
        get().updateNewsItem(item.id, { isAnalysing: true });
        const result = await analyzeHeadlineWithGemini(item);

        set((state) => ({
            analysisMode: result.reason === 'compliance_unavailable' ? state.analysisMode : result.mode,
            lastAnalysisNotice: result.notice ?? null,
            isSimulation: result.reason === 'compliance_unavailable' ? state.isSimulation : result.mode !== 'live',
            runtimeView: buildRuntimeView(
                state.runtimeStatus,
                state.feedMode,
                result.reason === 'compliance_unavailable' ? state.analysisMode : result.mode,
                result.reason === 'compliance_unavailable' ? state.lastAnalysisNotice : result.notice
            ),
            news: state.news.map((newsItem) => newsItem.id === item.id ? result.item : newsItem),
        }));
    },

    handleDeepDive: async (id) => {
        const item = get().news.find((newsItem) => newsItem.id === id);
        if (!item || item.deepDive || item.isDeepDiveLoading) return;

        get().updateNewsItem(id, { isDeepDiveLoading: true });

        const result = await generateDeepDive(
            item.headline,
            item.category,
            (item as any).relatedTickers ?? (item.affectedAssets ?? []),
            item.score ?? 0
        );

        if (result.blocked) {
            console.warn(`COMPLIANCE CRITICAL BLOCK: ${result.blockedMessage}`);
            get().updateNewsItem(id, { isDeepDiveLoading: false });
            return;
        }

        get().updateNewsItem(id, {
            deepDive: result.response,
            deepDiveMode: result.mode,
            deepDiveNotice: result.notice,
            isDeepDiveLoading: false,
            groundingSources: result.groundingSources,
            groundingUsed: result.groundingUsed,
        } as any);
    },

    handleManualAdd: (headline) => {
        const newItem: NewsItem = {
            id: Date.now().toString(),
            headline,
            timestamp: Date.now(),
            category: Category.ALL,
            source: 'Manual Entry',
            isAnalyzed: false,
            isAnalysing: false,
        };

        get().addNewsItem(newItem);
        get().processItem(newItem);
    },

    handleFetchFromX: async () => {
        if (get().isFetchingX) return;

        set({ isFetchingX: true });

        try {
            const backendNews = await fetchNewsFromBackend();
            if (backendNews.items.length > 0) {
                set((state) => ({
                    news: [...backendNews.items, ...state.news].slice(0, 80),
                    feedMode: backendNews.mode,
                    runtimeView: buildRuntimeView(state.runtimeStatus, backendNews.mode, state.analysisMode, state.lastAnalysisNotice),
                }));
                await processItemsSequentially(backendNews.items.slice(0, 5), (item) => get().processItem(item));
                return;
            }

            const xNews = await fetchNewsFromX();
            if (xNews.length > 0) {
                set((state) => ({
                    news: [...xNews, ...state.news],
                    feedMode: 'fallback',
                    runtimeView: buildRuntimeView(state.runtimeStatus, 'fallback', state.analysisMode, state.lastAnalysisNotice),
                }));
                await processItemsSequentially(xNews, (item) => get().processItem(item));
            }
        } catch (error) {
            console.error('Error fetching news:', error);
        } finally {
            set({ isFetchingX: false });
        }
    },

    seedInitialData: async () => {
        const runtimeStatus = await get().refreshRuntimeStatus();
        const backendNews = await fetchNewsFromBackend();

        if (backendNews.items.length > 0) {
            const nextAnalysisMode = runtimeStatus?.services.ai ?? get().analysisMode;
            set((state) => ({
                news: backendNews.items,
                feedMode: backendNews.mode,
                analysisMode: nextAnalysisMode,
                runtimeView: buildRuntimeView(runtimeStatus, backendNews.mode, nextAnalysisMode, state.lastAnalysisNotice),
            }));
            await processItemsSequentially(backendNews.items.slice(0, 3), (item) => get().processItem(item));
            return;
        }

        const initialData = Array.from({ length: 3 }).map(generateNewsItem);
        set((state) => ({
            news: initialData,
            feedMode: 'fallback',
            analysisMode: runtimeStatus?.services.ai ?? 'fallback',
            isSimulation: true,
            runtimeView: buildRuntimeView(runtimeStatus, 'fallback', runtimeStatus?.services.ai ?? 'fallback', state.lastAnalysisNotice),
        }));
        await processItemsSequentially(initialData, (item) => get().processItem(item));
    },

    filteredNews: () => {
        const { news, activeCategory } = get();
        return activeCategory === Category.ALL ? news : news.filter((item) => item.category === activeCategory);
    },
}));
