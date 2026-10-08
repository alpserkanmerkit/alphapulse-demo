import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Hash, Pause, Play, Terminal } from 'lucide-react';
import NewsCard from '../components/NewsCard';
import { useNewsStore } from '../stores/newsStore';
import { Category } from '../types';
import { fetchNewsFromBackend, useAnalyzeNews, useDeepDiveNews, useNews, NEWS_FEED_LIMIT, NEWS_QUERY_KEY, NewsQueryResult } from '../hooks/queries/useNewsQueries';
import { useQueryClient } from '@tanstack/react-query';

const DashboardPage: React.FC = () => {
    const { activeCategory, isStreamActive, toggleStream, setNewsItems } = useNewsStore();
    const newsQuery = useNews(isStreamActive);
    const analyzeMutation = useAnalyzeNews();
    const { mutate: deepDive } = useDeepDiveNews();
    const queryClient = useQueryClient();
    const scrollRef = useRef<HTMLDivElement>(null);
    const autoAnalyzeSeenRef = useRef(new Set<string>());
    const autoAnalyzeActiveRef = useRef(false);
    const [isManualFetchActive, setIsManualFetchActive] = useState(false);
    const allNews = newsQuery.data?.items ?? [];

    useEffect(() => {
        if (newsQuery.data) {
            setNewsItems(newsQuery.data.items, newsQuery.data.mode);
        }
    }, [newsQuery.data, setNewsItems]);

    const news = activeCategory === Category.ALL
        ? allNews
        : allNews.filter((item) => item.category === activeCategory);
    const criticalNews = news.filter((item) => item.score && item.score > 90);

    const handleRefetch = async () => {
        if (isManualFetchActive) return;
        setIsManualFetchActive(true);
        try {
            const refreshed = await fetchNewsFromBackend({ force: true });
            queryClient.setQueryData<NewsQueryResult>(NEWS_QUERY_KEY, refreshed);
            setNewsItems(refreshed.items, refreshed.mode);
        } finally {
            setIsManualFetchActive(false);
        }
    };

    useEffect(() => {
        if (!isStreamActive || !newsQuery.data || autoAnalyzeActiveRef.current) return;

        const nextItem = newsQuery.data.items.slice(0, NEWS_FEED_LIMIT).find((item) =>
            !item.isAnalyzed
            && !item.isAnalysing
            && !item.analysisQueued
            && !autoAnalyzeSeenRef.current.has(item.id)
        );

        if (!nextItem) return;

        autoAnalyzeSeenRef.current.add(nextItem.id);
        autoAnalyzeActiveRef.current = true;
        queryClient.setQueryData<NewsQueryResult>(NEWS_QUERY_KEY, (old) =>
            old
                ? { ...old, items: old.items.map((item) => item.id === nextItem.id ? { ...item, analysisQueued: true } : item) }
                : old
        );

        analyzeMutation.mutate(nextItem, {
            onSettled: () => {
                autoAnalyzeActiveRef.current = false;
            },
        });
    }, [analyzeMutation, isStreamActive, newsQuery.data, queryClient]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <header className="ap-page-header">
                <div>
                    <h2 className="ap-page-title">
                        <Terminal size={18} style={{ color: 'var(--ap-accent)' }} />
                        Live Intelligence Feed
                    </h2>
                    <p className="ap-page-sub">Real-time NLP analysis - AlphaScore - Multi-source</p>
                </div>
                <div className="ap-header-actions">
                    <button
                        onClick={() => { void handleRefetch(); }}
                        disabled={isManualFetchActive}
                        aria-busy={isManualFetchActive}
                        className="ap-btn ap-btn--ghost ap-btn--sm"
                    >
                        <Hash size={13} />
                        {isManualFetchActive ? 'Fetching...' : 'Fetch Latest'}
                    </button>
                    <button onClick={toggleStream} className={`ap-btn ap-btn--sm ${isStreamActive ? 'ap-btn--live' : 'ap-btn--paused'}`}>
                        {isStreamActive ? <Pause size={13} /> : <Play size={13} />}
                        {isStreamActive ? 'Live' : 'Paused'}
                    </button>
                </div>
            </header>

            {criticalNews.length > 0 && (
                <div className="ap-critical-ticker">
                    <AlertTriangle size={14} style={{ color: 'var(--ap-bear)', flexShrink: 0, animation: 'pulse-glow 1.5s infinite' }} />
                    <span className="ap-ticker-label">CRITICAL ALERT:</span>
                    <div className="ap-ticker-items">
                        {[...criticalNews, ...criticalNews].map((item, index) => (
                            <span key={`${item.id}-${index}`} className="ap-ticker-item">
                                {item.headline} <span className="ap-ticker-score">({item.score})</span>
                            </span>
                        ))}
                    </div>
                </div>
            )}

            <div className="ap-scroll-area" ref={scrollRef}>
                <div className="ap-content-max">
                    {newsQuery.isLoading ? (
                        <div className="ap-empty">
                            <div className="ap-empty-icon" style={{ animation: 'spin 2s linear infinite' }}>
                                <Terminal size={32} style={{ color: 'var(--ap-accent)' }} />
                            </div>
                            <p className="ap-empty-title">Initializing Neural Networks...</p>
                            <p className="ap-empty-sub">Connecting to market intelligence feeds</p>
                        </div>
                    ) : news.length === 0 ? (
                        <div className="ap-empty">
                            <p className="ap-empty-title">No Intelligence Found</p>
                            <p className="ap-empty-sub">Wait for new data to arrive</p>
                        </div>
                    ) : (
                        news.map((item) => (
                            <NewsCard
                                key={item.id}
                                item={item}
                                onAnalyze={() => analyzeMutation.mutate(item)}
                                onGenerateDeepDive={() => deepDive(item)}
                            />
                        ))
                    )}
                    <div style={{ height: 80 }} />
                </div>
            </div>
        </div>
    );
};

export default DashboardPage;
