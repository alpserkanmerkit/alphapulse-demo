import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NewsItem, Sentiment } from '../../types';
import { generateNewsItem } from '../../services/marketData';
import { apiFetch } from '../../utils/apiClient';

export const NEWS_QUERY_KEY = ['newsFeed'] as const;
export const NEWS_FEED_LIMIT = 3;
const analyzedNewsMemory = new Map<string, Partial<NewsItem>>();

export interface NewsQueryResult {
    items: NewsItem[];
    mode: 'live' | 'fallback';
}

interface FetchNewsOptions {
    force?: boolean;
}

const newsMemoryKey = (item: Pick<NewsItem, 'id' | 'headline'>) => item.id || item.headline;

function mergeRememberedAnalysis(item: NewsItem): NewsItem {
    const remembered = analyzedNewsMemory.get(newsMemoryKey(item));
    return remembered ? { ...item, ...remembered } : item;
}

export const fetchNewsFromBackend = async (options: FetchNewsOptions = {}): Promise<NewsQueryResult> => {
    try {
        const query = new URLSearchParams({ limit: String(NEWS_FEED_LIMIT) });
        if (options.force) query.set('refresh', '1');
        const response = await apiFetch(`/api/news/feed?${query.toString()}`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Backend ${response.status}`);
        const json = await response.json();
        const items = (json.items ?? []).map((item: Partial<NewsItem>) => ({
            ...item,
            isAnalyzed: false,
            isAnalysing: false,
            analysisQueued: false,
        } as NewsItem)).map(mergeRememberedAnalysis);
        return { items, mode: 'live' };
    } catch {
        console.warn('[NewsQueries] Backend unavailable, using mock data');
        return { items: Array.from({ length: NEWS_FEED_LIMIT }).map(generateNewsItem).map(mergeRememberedAnalysis), mode: 'fallback' };
    }
};

export const analyzeHeadlineBackend = async (item: NewsItem): Promise<NewsItem> => {
    try {
        const response = await apiFetch('/api/ai/analyze', {
            method: 'POST',
            body: JSON.stringify({ headline: item.headline, category: item.category, source: item.source }),
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error(`Analyze failed: ${response.status}`);
        const data = await response.json();
        const score = typeof data.score === 'number'
            ? data.score
            : typeof data.alphaScore === 'number'
                ? data.alphaScore
                : undefined;
        const analyzedItem = {
            ...item,
            isAnalyzed: true,
            isAnalysing: false,
            analysisQueued: false,
            analysisError: undefined,
            score,
            summary: data.summary || '',
            affectedAssets: data.tickers || [],
            sentiment: data.sentiment || Sentiment.NEUTRAL,
            analysisMode: data.mode,
            analysisNotice: data.notice,
        };
        analyzedNewsMemory.set(newsMemoryKey(analyzedItem), analyzedItem);
        return analyzedItem;
    } catch (error) {
        console.error('[NewsQueries] Analyze error:', error);
        const failedItem = {
            ...item,
            isAnalysing: false,
            isAnalyzed: false,
            analysisQueued: false,
            analysisError: 'Analysis failed. Retry when the AI route is available.',
            analysisNotice: 'Analysis failed. Retry when the AI route is available.',
            sentiment: Sentiment.NEUTRAL,
        };
        analyzedNewsMemory.set(newsMemoryKey(failedItem), failedItem);
        return failedItem;
    }
};

export const deepDiveFromBackend = async (item: NewsItem) => {
    const response = await apiFetch('/api/ai/deep-dive', {
        method: 'POST',
        body: JSON.stringify({
            headline: item.headline,
            category: item.category,
            tickers: item.relatedTickers ?? item.affectedAssets ?? [],
            alphaScore: item.score ?? 0,
        }),
        signal: AbortSignal.timeout(30000),
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 403 && json.error === 'COMPLIANCE_BLOCK') {
            return { error: 'COMPLIANCE_BLOCK', message: json.message };
        }
        throw new Error(`Backend deep-dive ${response.status}`);
    }

    return {
        deepDive: { content: json.content, scenarios: json.scenarios ?? [] },
        deepDiveMode: json.mode,
        deepDiveNotice: json.notice,
        groundingSources: json.sources ?? [],
        groundingUsed: json.groundingUsed ?? false,
    };
};

export const useNews = (isLive = true) => useQuery({
    queryKey: NEWS_QUERY_KEY,
    queryFn: () => fetchNewsFromBackend(),
    staleTime: isLive ? 10 * 1000 : 60 * 1000,
    refetchInterval: isLive ? 15 * 1000 : false,
});

export const useAnalyzeNews = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: analyzeHeadlineBackend,
        onMutate: async (item) => {
            await queryClient.cancelQueries({ queryKey: NEWS_QUERY_KEY });
            const previousNews = queryClient.getQueryData<NewsQueryResult>(NEWS_QUERY_KEY);
            if (previousNews) {
                queryClient.setQueryData<NewsQueryResult>(NEWS_QUERY_KEY, (old) =>
                    old
                        ? { ...old, items: old.items.map((newsItem) => newsItem.id === item.id ? { ...newsItem, isAnalysing: true, analysisQueued: false, analysisError: undefined, analysisNotice: undefined } : newsItem) }
                        : old
                );
            }
            return { previousNews };
        },
        onError: (_error, _item, context) => {
            if (context?.previousNews) {
                queryClient.setQueryData(NEWS_QUERY_KEY, context.previousNews);
            }
        },
        onSuccess: (analyzedItem) => {
            if (analyzedItem.isAnalyzed || analyzedItem.analysisError) {
                analyzedNewsMemory.set(newsMemoryKey(analyzedItem), {
                    isAnalyzed: analyzedItem.isAnalyzed,
                    isAnalysing: false,
                    analysisQueued: false,
                    analysisError: analyzedItem.analysisError,
                    analysisNotice: analyzedItem.analysisNotice,
                    score: analyzedItem.score,
                    summary: analyzedItem.summary,
                    affectedAssets: analyzedItem.affectedAssets,
                    sentiment: analyzedItem.sentiment,
                    analysisMode: analyzedItem.analysisMode,
                });
            }
            queryClient.setQueryData<NewsQueryResult>(NEWS_QUERY_KEY, (old) =>
                old
                    ? { ...old, items: old.items.map((newsItem) => newsItem.id === analyzedItem.id ? analyzedItem : newsItem) }
                    : old
            );
        },
    });
};

export const useDeepDiveNews = () => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: deepDiveFromBackend,
        onMutate: async (item) => {
            await queryClient.cancelQueries({ queryKey: NEWS_QUERY_KEY });
            const previousNews = queryClient.getQueryData<NewsQueryResult>(NEWS_QUERY_KEY);
            if (previousNews) {
                queryClient.setQueryData<NewsQueryResult>(NEWS_QUERY_KEY, (old) =>
                    old
                        ? { ...old, items: old.items.map((newsItem) => newsItem.id === item.id ? { ...newsItem, isDeepDiveLoading: true } : newsItem) }
                        : old
                );
            }
            return { previousNews };
        },
        onError: (_error, _item, context) => {
            if (context?.previousNews) {
                queryClient.setQueryData(NEWS_QUERY_KEY, context.previousNews);
            }
        },
        onSuccess: (result, item) => {
            if ('error' in result) {
                queryClient.setQueryData<NewsQueryResult>(NEWS_QUERY_KEY, (old) =>
                    old
                        ? { ...old, items: old.items.map((newsItem) => newsItem.id === item.id ? { ...newsItem, isDeepDiveLoading: false } : newsItem) }
                        : old
                );
                return;
            }

            queryClient.setQueryData<NewsQueryResult>(NEWS_QUERY_KEY, (old) =>
                old
                    ? {
                        ...old,
                        items: old.items.map((newsItem) => newsItem.id === item.id ? {
                            ...newsItem,
                            ...result,
                            isDeepDiveLoading: false,
                        } : newsItem),
                    }
                    : old
            );
        },
    });
};
