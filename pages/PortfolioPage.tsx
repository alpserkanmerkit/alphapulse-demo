import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { AlertCircle, BarChart3, DollarSign, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import { usePortfolioStore } from '../stores/portfolioStore';
import type { PortfolioStateModel, Position } from '../stores/portfolioStore';
import type { PortfolioRiskResponse } from '../types';
import apiClient, { getApiErrorMessage } from '../utils/apiClient';
import PortfolioPriceChart from '../components/PortfolioPriceChart';

const fmt = (value: number) =>
    value >= 1_000_000_000 ? `$${(value / 1_000_000_000).toFixed(2)}B`
        : value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(1)}M`
            : `$${value.toLocaleString()}`;

export interface PriceTick {
    symbol: string;
    name: string;
    price: number;
    change24h: number;
    changePercent24h: number;
    updatedAt: number;
    source: string;
    freshnessStatus?: 'fresh' | 'stale' | 'unknown';
}

interface ChartPoint {
    symbol?: string;
    price: number;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close?: number | null;
    volume?: number | null;
    timestamp: number;
    source?: string;
    providerPolicy?: string;
    interval?: string;
}

type PriceTimeframe = '3M' | '6M' | '12M' | '24M';
export type HistoryStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';
type HistoryQuality = {
    status: HistoryStatus;
    observations: number;
    source?: string;
    error?: string;
};

type LivePosition = Position & {
    liveTick?: PriceTick;
    livePrice: number;
    holdingPnL: number;
    pnlPct: number;
};

interface StrategyTicketState {
    strategyTicket?: {
        ticker: string;
        side: 'BUY' | 'SELL';
        quantity?: number;
        price?: number;
        source?: string;
    };
}

const PRICE_POLL_INTERVAL_MS = 15 * 1000;
const HISTORY_POINT_LIMIT = 48;
const PRICE_TIMEFRAMES: PriceTimeframe[] = ['24M', '12M', '6M', '3M'];

export function isLivePriceSource(source?: string): boolean {
    const normalized = source?.toLowerCase() ?? '';
    return Boolean(normalized && normalized !== 'simulated' && normalized !== 'persisted' && !normalized.startsWith('stale:'));
}

export function isStalePriceSource(source?: string): boolean {
    return Boolean(source?.toLowerCase().startsWith('stale:'));
}

export function isUsablePriceSource(source?: string): boolean {
    return isLivePriceSource(source) || isStalePriceSource(source);
}

export function getExecutionPriceForPosition(position: Pick<Position, 'currentPrice' | 'averagePrice'> & { livePrice?: number }): number {
    return position.livePrice && position.livePrice > 0
        ? position.livePrice
        : position.currentPrice > 0
            ? position.currentPrice
            : position.averagePrice;
}

export function isSellQuantityWithinPosition(quantity: number, positionQuantity?: number): boolean {
    return Boolean(positionQuantity && quantity > 0 && quantity <= positionQuantity + Number.EPSILON);
}

export const mergeChartHistory = (current: ChartPoint[], incoming: ChartPoint[], limit = HISTORY_POINT_LIMIT) => {
    const byKey = new Map<string, ChartPoint>();
    for (const point of [...current, ...incoming]) {
        if (!isUsablePriceSource(point.source)) continue;
        byKey.set(`${point.timestamp}:${point.price}:${point.source ?? ''}`, point);
    }

    const merged = Array.from(byKey.values())
        .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp))
        .sort((a, b) => a.timestamp - b.timestamp);

    return limit > 0 ? merged.slice(-limit) : merged;
};

export function deriveLivePortfolioMetrics(portfolio: PortfolioStateModel, prices: PriceTick[]) {
    const usablePrices = prices.filter((tick) => Number.isFinite(tick.price) && tick.price > 0 && isUsablePriceSource(tick.source));
    const priceBySymbol = new Map(usablePrices.map((tick) => [tick.symbol.toUpperCase(), tick]));
    const livePositions: LivePosition[] = portfolio.positions.map((position) => {
        const liveTick = priceBySymbol.get(position.ticker.toUpperCase());
        const livePrice = liveTick?.price ?? position.currentPrice;
        const holdingPnL = (livePrice - position.averagePrice) * position.quantity;
        const pnlPct = position.averagePrice > 0 ? ((livePrice - position.averagePrice) / position.averagePrice) * 100 : 0;
        return { ...position, liveTick, livePrice, holdingPnL, pnlPct };
    });
    const liveMarketValue = livePositions.reduce((total, position) => total + position.livePrice * position.quantity, 0);
    const liveCost = livePositions.reduce((total, position) => total + position.averagePrice * position.quantity, 0);
    const livePnL = liveMarketValue - liveCost;
    const livePnlPercent = liveCost > 0 ? (livePnL / liveCost) * 100 : 0;
    const liveEquity = portfolio.cashBalance + liveMarketValue;

    return { priceBySymbol, livePositions, liveMarketValue, liveCost, livePnL, livePnlPercent, liveEquity };
}

const formatChartDate = (timestamp: number, timeframe: PriceTimeframe) =>
    new Date(timestamp).toLocaleDateString([], timeframe === '24M' || timeframe === '12M'
        ? { month: 'short', year: '2-digit' }
        : { month: 'short', day: 'numeric' });

const formatPct = (value: number) => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;

const formatPriceSourceLabel = (source?: string) => {
    if (!source) return 'Provider unavailable';
    return source.toLowerCase().startsWith('stale:') ? `Stale ${source.slice('stale:'.length)}` : source;
};

export function isQuoteCompatibleWithHistory(price: number, history: ChartPoint[]): boolean {
    if (!Number.isFinite(price) || price <= 0 || history.length < 2) return true;
    const lastPoint = history[history.length - 1];
    const lastPrice = Number(lastPoint.close ?? lastPoint.price);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) return true;
    const ratio = price / lastPrice;
    return ratio >= 0.7 && ratio <= 1.3;
}

export const shouldShowTimeframeReturn = (status: HistoryStatus, points: ChartPoint[]) =>
    status === 'ready' && points.length > 1;

const PortfolioPage: React.FC = () => {
    const location = useLocation();
    const initialStrategyTicket = (location.state as StrategyTicketState | null)?.strategyTicket;
    const { portfolio, isLoading, isTrading, error, fetchPortfolio, tradeStock } = usePortfolioStore();
    const [tradeType, setTradeType] = useState<'BUY' | 'SELL'>(initialStrategyTicket?.side ?? 'BUY');
    const [ticker, setTicker] = useState(initialStrategyTicket?.ticker.toUpperCase() ?? '');
    const [quantity, setQuantity] = useState(initialStrategyTicket?.quantity ? String(initialStrategyTicket.quantity) : '');
    const [price, setPrice] = useState(initialStrategyTicket?.price ? String(initialStrategyTicket.price) : '');
    const [priceTouched, setPriceTouched] = useState(Boolean(initialStrategyTicket?.price));
    const [prices, setPrices] = useState<PriceTick[]>([]);
    const [priceHistory, setPriceHistory] = useState<Record<string, ChartPoint[]>>({});
    const [historyStatusBySymbol, setHistoryStatusBySymbol] = useState<Record<string, HistoryStatus>>({});
    const [historyQualityBySymbol, setHistoryQualityBySymbol] = useState<Record<string, HistoryQuality>>({});
    const [selectedTimeframe, setSelectedTimeframe] = useState<PriceTimeframe>('24M');
    const [selectedTicker, setSelectedTicker] = useState<string>(initialStrategyTicket?.ticker.toUpperCase() ?? '');
    const [priceFeedStatus, setPriceFeedStatus] = useState<'loading' | 'live' | 'delayed'>('loading');
    const [priceFeedMessage, setPriceFeedMessage] = useState('Connecting to live price feed...');
    const [risk, setRisk] = useState<PortfolioRiskResponse | null>(null);
    const [riskError, setRiskError] = useState<string | null>(null);
    const [riskLoading, setRiskLoading] = useState(false);
    const portfolioSymbols = portfolio?.positions.map((position) => position.ticker.toUpperCase()).sort().join(',') ?? '';

    useEffect(() => {
        void fetchPortfolio();
    }, [fetchPortfolio]);

    useEffect(() => {
        let cancelled = false;

        const fetchPrices = async () => {
            try {
                const response = await apiClient.get('/api/news/prices', {
                    params: portfolioSymbols ? { symbols: portfolioSymbols } : undefined,
                });
                const nextPrices = (response.data.prices ?? []) as PriceTick[];
                if (cancelled) return;

                setPrices(nextPrices);
                const hasLivePrices = nextPrices.some((tick) => isLivePriceSource(tick.source));
                const hasStalePrices = nextPrices.some((tick) => isStalePriceSource(tick.source));
                setPriceFeedStatus(hasLivePrices ? 'live' : 'delayed');
                setPriceFeedMessage(hasLivePrices
                    ? 'Live price feed connected'
                    : hasStalePrices
                        ? 'Live quotes delayed. Using stale provider cache.'
                        : 'Live quotes unavailable. No simulated prices are shown.');
            } catch (fetchError) {
                if (cancelled) return;
                setPriceFeedStatus('delayed');
                setPriceFeedMessage(getApiErrorMessage(fetchError, 'Live price feed delayed. Using last known prices.'));
            }
        };

        void fetchPrices();
        const interval = window.setInterval(fetchPrices, PRICE_POLL_INTERVAL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, [portfolioSymbols]);

    useEffect(() => {
        if (!portfolioSymbols) {
            setHistoryStatusBySymbol({});
            setHistoryQualityBySymbol({});
            return;
        }
        let cancelled = false;
        const requestedSymbols = portfolioSymbols.split(',').filter(Boolean);

        const fetchHistory = async () => {
            setHistoryStatusBySymbol((current) => {
                const next = { ...current };
                for (const symbol of requestedSymbols) {
                    next[symbol] = 'loading';
                }
                return next;
            });
            try {
                const response = await apiClient.get('/api/news/prices/history', {
                    params: { symbols: portfolioSymbols, range: selectedTimeframe },
                });
                const history = (response.data.history ?? {}) as Record<string, ChartPoint[]>;
                const errors = (response.data.errors ?? response.data.dataQuality?.errors ?? {}) as Record<string, string>;
                const historySource = response.data.dataQuality?.source as string | undefined;
                if (cancelled) return;

                setPriceHistory((current) => {
                    const next = { ...current };
                    for (const [symbol, points] of Object.entries(history)) {
                        next[symbol.toUpperCase()] = points
                            .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp))
                            .sort((a, b) => a.timestamp - b.timestamp);
                    }
                    return next;
                });
                setHistoryStatusBySymbol((current) => {
                    const next = { ...current };
                    for (const symbol of requestedSymbols) {
                        const points = history[symbol] ?? history[symbol.toUpperCase()] ?? [];
                        const validPointCount = points.filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp)).length;
                        next[symbol] = validPointCount > 1 ? 'ready' : errors[symbol] ? 'error' : 'empty';
                    }
                    return next;
                });
                setHistoryQualityBySymbol((current) => {
                    const next = { ...current };
                    for (const symbol of requestedSymbols) {
                        const points = history[symbol] ?? history[symbol.toUpperCase()] ?? [];
                        const validPointCount = points.filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp)).length;
                        next[symbol] = {
                            status: validPointCount > 1 ? 'ready' : errors[symbol] ? 'error' : 'empty',
                            observations: validPointCount,
                            source: historySource ?? points[0]?.source,
                            error: errors[symbol],
                        };
                    }
                    return next;
                });
            } catch (fetchError) {
                if (cancelled) return;
                setHistoryStatusBySymbol((current) => {
                    const next = { ...current };
                    for (const symbol of requestedSymbols) {
                        next[symbol] = 'error';
                    }
                    return next;
                });
                setHistoryQualityBySymbol((current) => {
                    const next = { ...current };
                    for (const symbol of requestedSymbols) {
                        next[symbol] = {
                            status: 'error',
                            observations: 0,
                            error: getApiErrorMessage(fetchError, 'History unavailable'),
                        };
                    }
                    return next;
                });
                console.warn('[Portfolio] Historical tape delayed:', getApiErrorMessage(fetchError, 'History unavailable'));
            }
        };

        void fetchHistory();
        return () => {
            cancelled = true;
        };
    }, [portfolioSymbols, selectedTimeframe]);

    useEffect(() => {
        if (!portfolioSymbols) {
            setRisk(null);
            return;
        }
        let cancelled = false;

        const fetchRisk = async () => {
            setRiskLoading(true);
            setRiskError(null);
            try {
                const response = await apiClient.get('/api/portfolio/risk', {
                    params: { range: selectedTimeframe, confidence: 95, horizonDays: 1 },
                });
                if (!cancelled) {
                    setRisk(response.data.risk);
                }
            } catch (fetchError) {
                if (!cancelled) {
                    setRiskError(getApiErrorMessage(fetchError, 'Portfolio risk is temporarily unavailable.'));
                }
            } finally {
                if (!cancelled) {
                    setRiskLoading(false);
                }
            }
        };

        void fetchRisk();
        return () => {
            cancelled = true;
        };
    }, [portfolioSymbols, selectedTimeframe]);

    if (isLoading && !portfolio) {
        return <div className="ap-empty"><p>Loading portfolio...</p></div>;
    }

    if (!portfolio) {
        return (
            <div className="ap-empty">
                <p>{error || 'No portfolio data available. Check database setup and authentication.'}</p>
            </div>
        );
    }

    const { priceBySymbol, livePositions, livePnL, livePnlPercent, liveEquity } = deriveLivePortfolioMetrics(portfolio, prices);
    const effectiveSelectedTicker = selectedTicker || livePositions[0]?.ticker || '';
    const activePosition = livePositions.find((position) => position.ticker === effectiveSelectedTicker) ?? livePositions[0];
    const activeTick = activePosition?.liveTick;
    const activeTickIsLive = isLivePriceSource(activeTick?.source);
    const activeTickIsStale = isStalePriceSource(activeTick?.source);
    const activeHistoryStatus = activePosition ? historyStatusBySymbol[activePosition.ticker.toUpperCase()] ?? 'idle' : 'idle';
    const activeHistoryQuality = activePosition ? historyQualityBySymbol[activePosition.ticker.toUpperCase()] : undefined;
    const activeRangeHistory = activePosition ? priceHistory[activePosition.ticker.toUpperCase()] ?? [] : [];
    const activeTickPoint = activeTick && isUsablePriceSource(activeTick.source) && isQuoteCompatibleWithHistory(activeTick.price, activeRangeHistory)
        ? [{
            price: activeTick.price,
            timestamp: activeTick.updatedAt,
            source: activeTick.source,
            open: activeTick.price,
            high: activeTick.price,
            low: activeTick.price,
            close: activeTick.price,
        }]
        : [];
    const activeHistory = activePosition
        ? mergeChartHistory(
            activeRangeHistory,
            activeTickPoint,
            0
        )
        : [];
    const activeHistoryStats = activeHistory.length > 0
        ? {
            min: Math.min(...activeHistory.map((point) => point.price)),
            max: Math.max(...activeHistory.map((point) => point.price)),
            last: activeHistory[activeHistory.length - 1].price,
            first: activeHistory[0].price,
        }
        : null;
    const hasReadyRangeHistory = shouldShowTimeframeReturn(activeHistoryStatus, activeHistory);
    const timeframeReturn = activeHistoryStats && activeHistoryStats.first > 0
        ? ((activeHistoryStats.last - activeHistoryStats.first) / activeHistoryStats.first) * 100
        : 0;
    const xAxisLabels = activeHistory.length > 1
        ? [activeHistory[0], activeHistory[Math.floor(activeHistory.length / 2)], activeHistory[activeHistory.length - 1]]
        : [];
    const activeObservationCount = activeHistoryQuality?.observations ?? activeRangeHistory.length;
    const activeHistorySource = activeHistoryQuality?.source ?? activeRangeHistory[0]?.source ?? activeTick?.source ?? 'Market';
    const activeMarketLabel = activeTickIsLive ? 'LIVE' : activeTickIsStale ? 'STALE' : 'UNAVAILABLE';
    const historyStatusLabel = activeHistoryStatus === 'ready'
        ? 'READY'
        : activeHistoryStatus === 'loading'
            ? 'LOADING'
            : activeHistoryStatus === 'error'
                ? 'DELAYED'
                : activeHistoryStatus === 'empty'
                    ? 'EMPTY'
                    : 'STANDBY';
    const historyStatusClass = activeHistoryStatus === 'ready'
        ? 'ap-badge--bull'
        : activeHistoryStatus === 'loading'
            ? 'ap-badge--neutral'
            : 'ap-badge--warn';
    const currentTradeSymbol = ticker.trim().toUpperCase();
    const currentTradePosition = livePositions.find((position) => position.ticker.toUpperCase() === currentTradeSymbol);
    const suggestedExecutionPrice = currentTradeSymbol ? priceBySymbol.get(currentTradeSymbol)?.price : undefined;
    const displayedExecutionPrice = price || (!priceTouched && suggestedExecutionPrice ? String(suggestedExecutionPrice) : '');
    const requestedSellQuantity = Number.parseFloat(quantity);
    const sellHasPosition = tradeType !== 'SELL' || Boolean(currentTradePosition);
    const sellQuantityValid = tradeType !== 'SELL' || isSellQuantityWithinPosition(requestedSellQuantity, currentTradePosition?.quantity);
    const canSubmitTrade = !isTrading && sellHasPosition && sellQuantityValid;

    const getSuggestedPriceForTicker = (symbol: string) =>
        prices.find((tick) => tick.symbol.toUpperCase() === symbol.trim().toUpperCase())?.price;

    const prefillSellTicket = (position: LivePosition) => {
        setSelectedTicker(position.ticker);
        setTradeType('SELL');
        setTicker(position.ticker);
        setQuantity(String(position.quantity));
        setPrice(String(getExecutionPriceForPosition(position)));
        setPriceTouched(true);
    };

    const handleTrade = async (event: React.FormEvent) => {
        event.preventDefault();
        const qty = Number.parseFloat(quantity);
        const suggestedPrice = !priceTouched ? getSuggestedPriceForTicker(ticker) : undefined;
        const fallbackPrice = tradeType === 'SELL' && currentTradePosition ? getExecutionPriceForPosition(currentTradePosition) : undefined;
        const executionPrice = Number.parseFloat(price || String(suggestedPrice ?? fallbackPrice ?? ''));
        if (qty > 0 && executionPrice > 0 && ticker.trim() && canSubmitTrade) {
            const success = await tradeStock(ticker.toUpperCase(), tradeType, qty, executionPrice);
            if (success) {
                setTicker('');
                setQuantity('');
                setPrice('');
                setPriceTouched(false);
            }
        }
    };

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
            <header className="ap-page-header">
                <div>
                    <h2 className="ap-page-title">
                        <BarChart3 size={18} style={{ color: 'var(--ap-accent)' }} />
                        Live Portfolio
                    </h2>
                    <p className="ap-page-sub">{portfolio.positions.length} positions - Price sync enabled</p>
                </div>
                <div className="ap-header-actions">
                    <button onClick={() => void fetchPortfolio()} className="ap-btn ap-btn--ghost ap-btn--sm" disabled={isLoading}>
                        <RefreshCw size={13} style={isLoading ? { animation: 'spin 1s linear infinite' } : undefined} /> Refresh
                    </button>
                </div>
            </header>

            <div className="ap-scroll-area">
                <div className="ap-stat-grid">
                    <div className="ap-stat-tile">
                        <span className="ap-stat-label"><DollarSign size={10} className="inline" /> Total Balance</span>
                        <span className="ap-stat-value ap-stat-value--gold">{fmt(liveEquity)}</span>
                    </div>
                    <div className="ap-stat-tile">
                        <span className="ap-stat-label"><DollarSign size={10} className="inline" /> Cash Available</span>
                        <span className="ap-stat-value ap-stat-value--neutral">{fmt(portfolio.cashBalance)}</span>
                    </div>
                    <div className="ap-stat-tile">
                        <span className="ap-stat-label">Unrealized P&amp;L</span>
                        <span className={`ap-stat-value ${livePnL >= 0 ? 'ap-stat-value--bull' : 'ap-stat-value--bear'}`}>
                            {livePnL >= 0 ? '+' : ''}{fmt(livePnL)}
                        </span>
                        <span className={`ap-stat-change ${livePnlPercent >= 0 ? 'ap-stat-change--pos' : 'ap-stat-change--neg'}`}>
                            {livePnlPercent >= 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                            {livePnlPercent.toFixed(2)}%
                        </span>
                    </div>
                </div>

                <div style={{ padding: '0 20px 20px' }}>
                    <div className="ap-card" data-testid="portfolio-live-chart" style={{ padding: 16, background: 'linear-gradient(180deg, rgba(15,23,42,0.92), rgba(2,6,23,0.96))', borderColor: activeTickIsLive ? 'rgba(34,197,94,0.28)' : 'var(--ap-border)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'start', marginBottom: 14, gap: 16 }}>
                            <div style={{ minWidth: 0 }}>
                                <p className="ap-section-title" style={{ margin: 0 }}>PRICE TAPE</p>
                                <h3 style={{ margin: '8px 0 0', fontSize: 20, color: 'var(--ap-text-heading)', fontFamily: 'JetBrains Mono', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                    {activePosition ? activePosition.ticker : 'NO POSITION'}
                                    {activePosition && (
                                        <span style={{ fontSize: 11, color: activeTickIsLive ? 'var(--ap-bull)' : activeTickIsStale ? 'var(--ap-warn)' : 'var(--ap-text-muted)' }}>
                                            {activeMarketLabel}
                                        </span>
                                    )}
                                </h3>
                            </div>
                            <div style={{ textAlign: 'right', minWidth: 190 }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: activeTickIsLive ? 'var(--ap-bull)' : activeTickIsStale || priceFeedStatus === 'delayed' ? 'var(--ap-warn)' : 'var(--ap-text-muted)', boxShadow: activeTickIsLive ? '0 0 12px var(--ap-bull)' : 'none' }} />
                                    <span style={{ fontSize: 10, color: 'var(--ap-text-muted)', fontFamily: 'JetBrains Mono' }}>
                                        {activeTick ? `${formatPriceSourceLabel(activeTick.source)} ${new Date(activeTick.updatedAt).toLocaleTimeString()}` : priceFeedMessage}
                                    </span>
                                </div>
                                {activePosition && (
                                    <>
                                        <p style={{ margin: '8px 0 0', fontSize: 24, color: (activeTick?.changePercent24h ?? 0) >= 0 ? 'var(--ap-bull)' : 'var(--ap-bear)', fontFamily: 'JetBrains Mono', fontWeight: 700 }}>
                                            ${activePosition.livePrice.toFixed(2)}
                                            <span style={{ marginLeft: 10, fontSize: 12 }}>
                                                {formatPct(activeTick?.changePercent24h ?? 0)}
                                            </span>
                                        </p>
                                        <p style={{ margin: '6px 0 0', fontSize: 10, color: activePosition.pnlPct >= 0 ? 'var(--ap-bull)' : 'var(--ap-bear)', fontFamily: 'JetBrains Mono' }}>
                                            Holding P&amp;L {formatPct(activePosition.pnlPct)}
                                        </p>
                                    </>
                                )}
                            </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', gap: 6 }}>
                                {PRICE_TIMEFRAMES.map((timeframe) => (
                                    <button
                                        key={timeframe}
                                        type="button"
                                        data-testid={`portfolio-timeframe-${timeframe}`}
                                        onClick={() => setSelectedTimeframe(timeframe)}
                                        className={`ap-btn ap-btn--sm ${selectedTimeframe === timeframe ? 'ap-btn--accent' : 'ap-btn--ghost'}`}
                                    >
                                        {timeframe}
                                    </button>
                                ))}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                <span data-testid="portfolio-history-status" className={`ap-badge ${historyStatusClass}`}>
                                    {historyStatusLabel} - {activeObservationCount} OBS
                                </span>
                                <span className="ap-badge ap-badge--neutral">
                                    {formatPriceSourceLabel(activeHistorySource)}
                                </span>
                                {hasReadyRangeHistory ? (
                                    <span style={{ fontSize: 11, color: timeframeReturn >= 0 ? 'var(--ap-bull)' : 'var(--ap-bear)', fontFamily: 'JetBrains Mono' }}>
                                        {selectedTimeframe} return {formatPct(timeframeReturn)}
                                    </span>
                                ) : activePosition ? (
                                    <span style={{ fontSize: 11, color: 'var(--ap-text-muted)', fontFamily: 'JetBrains Mono' }}>
                                        {selectedTimeframe} return unavailable
                                    </span>
                                ) : null}
                            </div>
                        </div>
                        <div style={{ border: '1px solid var(--ap-border)', borderRadius: 8, background: 'linear-gradient(180deg, rgba(15,23,42,0.58), rgba(2,6,23,0.78))', padding: 12 }}>
                            {activePosition ? (
                                <div style={{ display: 'grid', gridTemplateColumns: '72px minmax(0, 1fr)', gap: 12, minHeight: 292 }}>
                                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', color: 'var(--ap-text-muted)', fontSize: 10, fontFamily: 'JetBrains Mono', padding: '4px 0 26px' }}>
                                        <span>H {activeHistoryStats ? `$${activeHistoryStats.max.toFixed(2)}` : 'N/A'}</span>
                                        <span>L {activeHistoryStats ? `$${activeHistoryStats.min.toFixed(2)}` : 'N/A'}</span>
                                        <span>Last {activeHistoryStats ? `$${activeHistoryStats.last.toFixed(2)}` : 'N/A'}</span>
                                    </div>
                                    <div style={{ position: 'relative', minWidth: 0 }}>
                                        {!hasReadyRangeHistory && (
                                            <div data-testid="portfolio-history-collecting" style={{ position: 'absolute', top: 8, right: 10, zIndex: 1, color: activeHistoryStatus === 'error' ? 'var(--ap-warn)' : 'var(--ap-text-muted)', fontSize: 10, fontFamily: 'JetBrains Mono' }}>
                                                {activeHistoryStatus === 'error'
                                                    ? 'Historical tape delayed'
                                                    : activeHistoryStatus === 'empty'
                                                        ? 'Historical tape unavailable'
                                                        : 'Collecting historical tape'}
                                            </div>
                                        )}
                                        <PortfolioPriceChart points={activeHistory} isPositive={timeframeReturn >= 0} height={260} />
                                        <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--ap-text-muted)', fontSize: 10, fontFamily: 'JetBrains Mono', marginTop: 6 }}>
                                            {hasReadyRangeHistory && xAxisLabels.length > 0 ? xAxisLabels.map((point, index) => (
                                                <span key={`${point.timestamp}-${index}`}>{formatChartDate(point.timestamp, selectedTimeframe)}</span>
                                            )) : <span>Waiting for history</span>}
                                        </div>
                                        {activeHistoryQuality?.error && (
                                            <p style={{ margin: '6px 0 0', color: 'var(--ap-warn)', fontSize: 10, fontFamily: 'JetBrains Mono' }}>
                                                {activeHistoryQuality.error}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--ap-text-muted)', fontSize: 12 }}>
                                    Record a paper trade to open the live tape.
                                </div>
                            )}
                        </div>
                        {priceFeedStatus === 'delayed' && (
                            <p style={{ margin: '10px 0 0', color: 'var(--ap-warn)', fontSize: 11 }}>{priceFeedMessage}</p>
                        )}
                    </div>
                </div>

                <div style={{ padding: '0 20px 20px' }}>
                    <div className="ap-card" data-testid="portfolio-risk-panel" style={{ padding: 16 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                            <div>
                                <p className="ap-section-title" style={{ margin: 0 }}>PORTFOLIO RISK</p>
                                <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--ap-text-muted)' }}>
                                    VaR, stress scenarios, concentration and correlation over {selectedTimeframe}
                                </p>
                            </div>
                            {risk?.dataQuality && (
                                <span className={`ap-badge ${risk.dataQuality.status === 'ready' ? 'ap-badge--bull' : 'ap-badge--warn'}`}>
                                    {risk.dataQuality.status.toUpperCase()} · {risk.dataQuality.observations} OBS
                                </span>
                            )}
                        </div>

                        {riskLoading && <p style={{ margin: 0, fontSize: 12, color: 'var(--ap-text-muted)' }}>Calculating institutional risk...</p>}
                        {riskError && <p style={{ margin: 0, fontSize: 12, color: 'var(--ap-bear)' }}>{riskError}</p>}
                        {!riskLoading && risk?.metrics && (
                            <>
                                <div className="ap-stat-grid" style={{ padding: 0, gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
                                    <div className="ap-stat-tile">
                                        <span className="ap-stat-label">Historical VaR 95%</span>
                                        <span className="ap-stat-value ap-stat-value--bear">{fmt(risk.metrics.historicalVaR)}</span>
                                        <span className="ap-stat-change ap-stat-change--neg">{risk.metrics.historicalVaRPercent.toFixed(2)}%</span>
                                    </div>
                                    <div className="ap-stat-tile">
                                        <span className="ap-stat-label">Expected Shortfall</span>
                                        <span className="ap-stat-value ap-stat-value--warn">{fmt(risk.metrics.expectedShortfall)}</span>
                                        <span className="ap-stat-change ap-stat-change--neg">{risk.metrics.expectedShortfallPercent.toFixed(2)}%</span>
                                    </div>
                                    <div className="ap-stat-tile">
                                        <span className="ap-stat-label">Monte Carlo VaR</span>
                                        <span className="ap-stat-value ap-stat-value--neutral">{fmt(risk.metrics.monteCarloVaR)}</span>
                                        <span className="ap-stat-change">{risk.metrics.monteCarloVaRPercent.toFixed(2)}%</span>
                                    </div>
                                    <div className="ap-stat-tile">
                                        <span className="ap-stat-label">Annualized Vol</span>
                                        <span className="ap-stat-value ap-stat-value--gold">{risk.metrics.annualizedVolatility.toFixed(2)}%</span>
                                    </div>
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 0.65fr)', gap: 16, marginTop: 16 }}>
                                    <div>
                                        <p className="ap-section-title">STRESS TESTS</p>
                                        <div className="ap-table-wrap">
                                            <table className="ap-table">
                                                <thead>
                                                    <tr>
                                                        <th>SCENARIO</th>
                                                        <th>IMPACT</th>
                                                        <th>IMPACT %</th>
                                                        <th>VAR AFTER</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {risk.scenarios.map((scenario) => (
                                                        <tr key={scenario.id}>
                                                            <td>{scenario.name}</td>
                                                            <td className={scenario.portfolioImpact < 0 ? 'bear mono' : 'bull mono'}>{fmt(scenario.portfolioImpact)}</td>
                                                            <td className={scenario.portfolioImpactPercent < 0 ? 'bear mono' : 'bull mono'}>{formatPct(scenario.portfolioImpactPercent)}</td>
                                                            <td className="mono">{fmt(scenario.varAfter)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="ap-section-title">CONCENTRATION</p>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                            {risk.concentration.slice(0, 5).map((item) => (
                                                <div key={item.ticker}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontFamily: 'JetBrains Mono', marginBottom: 4 }}>
                                                        <span>{item.ticker}</span>
                                                        <span>{(item.weight * 100).toFixed(1)}%</span>
                                                    </div>
                                                    <div style={{ height: 6, background: 'var(--ap-bg-elevated)', borderRadius: 4, overflow: 'hidden' }}>
                                                        <div style={{ width: `${Math.min(item.weight * 100, 100)}%`, height: '100%', background: item.weight > 0.2 ? 'var(--ap-warn)' : 'var(--ap-accent)' }} />
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                        {risk.dataQuality.missingSymbols.length > 0 && (
                                            <p style={{ margin: '12px 0 0', fontSize: 11, color: 'var(--ap-warn)' }}>
                                                Limited history: {risk.dataQuality.missingSymbols.join(', ')}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 16, padding: '0 20px 20px' }}>
                    <div>
                        <p className="ap-section-title">CURRENT POSITIONS</p>
                        <div className="ap-table-wrap">
                            <table className="ap-table">
                                <thead>
                                    <tr>
                                        <th>TICKER</th>
                                        <th>QTY</th>
                                        <th>AVG PRICE</th>
                                        <th>CURRENT</th>
                                        <th>P&amp;L</th>
                                        <th>ACTION</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {livePositions.map((position) => (
                                        <tr key={position.id} onClick={() => prefillSellTicket(position)} style={{ cursor: 'pointer', background: effectiveSelectedTicker === position.ticker ? 'rgba(59,130,246,0.08)' : undefined }}>
                                            <td className="mono" style={{ color: 'var(--ap-accent)', fontWeight: 700 }}>{position.ticker}</td>
                                            <td className="mono">{position.quantity.toLocaleString()}</td>
                                            <td className="mono">${position.averagePrice.toFixed(2)}</td>
                                            <td className="mono">
                                                ${position.livePrice.toFixed(2)} {position.liveTick && (
                                                    <span className={isLivePriceSource(position.liveTick.source) ? 'bull' : undefined} style={{ fontSize: 9, color: isLivePriceSource(position.liveTick.source) ? undefined : 'var(--ap-warn)' }}>
                                                        {isLivePriceSource(position.liveTick.source) ? 'LIVE' : 'STALE'}
                                                    </span>
                                                )}
                                            </td>
                                            <td className={position.pnlPct >= 0 ? 'bull mono' : 'bear mono'}>
                                                {position.pnlPct >= 0 ? '+' : ''}{position.pnlPct.toFixed(1)}%
                                                <span style={{ fontSize: 10, display: 'block', opacity: 0.7 }}>
                                                    {position.holdingPnL >= 0 ? '+' : ''}{fmt(position.holdingPnL)}
                                                </span>
                                            </td>
                                            <td>
                                                <button
                                                    type="button"
                                                    className="ap-btn ap-btn--ghost ap-btn--sm"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        prefillSellTicket(position);
                                                    }}
                                                    style={{ color: 'var(--ap-bear)', borderColor: 'rgba(239,68,68,0.45)' }}
                                                >
                                                    Sell
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {portfolio.positions.length === 0 && (
                                        <tr>
                                            <td colSpan={6} style={{ textAlign: 'center', padding: 20, color: 'var(--ap-text-muted)' }}>
                                                No open positions. Use the Paper Trade Terminal to record a simulated trade.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>

                        <div style={{ marginTop: 20 }}>
                            <p className="ap-section-title">RECENT TRANSACTIONS</p>
                            <div className="ap-table-wrap">
                                <table className="ap-table">
                                    <thead>
                                        <tr>
                                            <th>TIME</th>
                                            <th>TICKER</th>
                                            <th>TYPE</th>
                                            <th>QTY</th>
                                            <th>PRICE</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {portfolio.transactions.map((transaction) => (
                                            <tr key={transaction.id}>
                                                <td className="mono" style={{ fontSize: 11 }}>{new Date(transaction.timestamp).toLocaleString()}</td>
                                                <td className="mono" style={{ color: 'var(--ap-accent)' }}>{transaction.ticker}</td>
                                                <td className={transaction.type === 'BUY' ? 'bull mono' : 'bear mono'}>{transaction.type}</td>
                                                <td className="mono">{transaction.quantity}</td>
                                                <td className="mono">${transaction.price.toFixed(2)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>

                    <div>
                        <p className="ap-section-title">PAPER TRADE TERMINAL</p>
                        <div className="ap-card" style={{ padding: 16 }}>
                            {error && (
                                <div style={{ background: 'rgba(255, 51, 51, 0.1)', color: '#ff3333', padding: 10, fontSize: 12, border: '1px solid #ff3333', marginBottom: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <AlertCircle size={14} /> {error}
                                </div>
                            )}

                            <form onSubmit={handleTrade} style={{ display: 'flex', flexDirection: 'column', gap: 15 }}>
                                <div style={{ display: 'flex', gap: 10 }}>
                                    <button type="button" onClick={() => setTradeType('BUY')} style={{ flex: 1, padding: 8, background: tradeType === 'BUY' ? 'var(--ap-bull)' : 'transparent', color: tradeType === 'BUY' ? '#000' : 'var(--ap-text-primary)', border: '1px solid var(--ap-bull)', cursor: 'pointer', fontWeight: 700 }}>
                                        BUY
                                    </button>
                                    <button type="button" onClick={() => setTradeType('SELL')} style={{ flex: 1, padding: 8, background: tradeType === 'SELL' ? 'var(--ap-bear)' : 'transparent', color: tradeType === 'SELL' ? '#000' : 'var(--ap-text-primary)', border: '1px solid var(--ap-bear)', cursor: 'pointer', fontWeight: 700 }}>
                                        SELL
                                    </button>
                                </div>

                                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, color: 'var(--ap-text-muted)' }}>
                                    TICKER
                                    <input className="ap-input" value={ticker} onChange={(event) => { setTicker(event.target.value.toUpperCase()); setPriceTouched(false); }} placeholder="e.g. AAPL" required style={{ textTransform: 'uppercase' }} />
                                </label>

                                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, color: 'var(--ap-text-muted)' }}>
                                    QUANTITY
                                    <input className="ap-input" type="number" value={quantity} onChange={(event) => setQuantity(event.target.value)} min="0.01" max={tradeType === 'SELL' ? currentTradePosition?.quantity : undefined} step="0.01" required />
                                    {tradeType === 'SELL' && (
                                        <span style={{ fontSize: 10, color: sellHasPosition && sellQuantityValid ? 'var(--ap-text-muted)' : 'var(--ap-bear)', fontFamily: 'JetBrains Mono' }}>
                                            {currentTradePosition ? `Available: ${currentTradePosition.quantity}` : 'No open position to sell'}
                                        </span>
                                    )}
                                </label>

                                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 11, color: 'var(--ap-text-muted)' }}>
                                    PAPER TRADE PRICE
                                    <input className="ap-input" type="number" value={displayedExecutionPrice} onChange={(event) => { setPrice(event.target.value); setPriceTouched(true); }} min="0.01" step="0.01" required />
                                    {currentTradeSymbol && priceBySymbol.get(currentTradeSymbol) && (
                                        <span style={{ fontSize: 10, color: isLivePriceSource(priceBySymbol.get(currentTradeSymbol)?.source) ? 'var(--ap-bull)' : 'var(--ap-warn)', fontFamily: 'JetBrains Mono' }}>
                                            {isLivePriceSource(priceBySymbol.get(currentTradeSymbol)?.source) ? 'Live' : 'Stale'} suggestion from {priceBySymbol.get(currentTradeSymbol)?.source}
                                        </span>
                                    )}
                                </label>

                                <button type="submit" disabled={!canSubmitTrade} style={{ width: '100%', padding: 10, background: canSubmitTrade ? 'var(--ap-accent)' : 'var(--ap-border)', color: '#000', border: 'none', fontWeight: 700, cursor: canSubmitTrade ? 'pointer' : 'not-allowed', marginTop: 10 }}>
                                    {isTrading ? 'LOGGING...' : tradeType === 'SELL' ? 'LOG PAPER SELL' : 'LOG PAPER BUY'}
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
                <div style={{ height: 40 }} />
            </div>
        </div>
    );
};

export default PortfolioPage;
