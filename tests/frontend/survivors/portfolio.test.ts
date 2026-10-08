import { describe, expect, it, vi } from 'vitest';

// Pure-helper tests never render icons; skip the ~100 ms lucide-react barrel import.
vi.mock('lucide-react', () => ({ AlertCircle: () => null, BarChart3: () => null, DollarSign: () => null, RefreshCw: () => null, TrendingDown: () => null, TrendingUp: () => null }));

import { deriveLivePortfolioMetrics, getExecutionPriceForPosition, isLivePriceSource, isQuoteCompatibleWithHistory, isSellQuantityWithinPosition, isUsablePriceSource, mergeChartHistory, PriceTick } from '../../../pages/PortfolioPage';
import { PortfolioStateModel } from '../../../stores/portfolioStore';

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('../helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

// Mutants closed here: p3, p8, p9, p10, p12, p14, p16, p18, p19, p21a/p21b, p22, p24, x8.
function position(ticker: string, quantity = 100, averagePrice = 100) {
    return { id: `pos-${ticker}`, ticker, quantity, averagePrice, currentPrice: averagePrice, updatedAt: '2026-04-30T12:00:00.000Z' };
}

function portfolioOf(...positions: ReturnType<typeof position>[]): PortfolioStateModel {
    return {
        id: 'p1', userId: 'u1', totalBalance: 100000, cashBalance: 90000, currentVaR: 0,
        updatedAt: '2026-04-30T12:00:00.000Z', positions, transactions: [],
    };
}

function tick(symbol: string, price: number, source = 'YahooFinance'): PriceTick {
    return { symbol, name: symbol, price, change24h: 0, changePercent24h: 0, updatedAt: 1, source };
}

describe('survivors: deriveLivePortfolioMetrics', () => {
    it('reports P&L as percentages, not fractions', () => {
        const result = deriveLivePortfolioMetrics(portfolioOf(position('AAPL')), [tick('AAPL', 105)]);

        expect(result.livePositions[0].pnlPct).toBeCloseTo(5, 10);
        expect(result.livePnlPercent).toBeCloseTo(5, 10);
    });

    it('ignores ticks whose price is zero or negative', () => {
        const result = deriveLivePortfolioMetrics(portfolioOf(position('AAPL'), position('MSFT')), [tick('AAPL', 0), tick('MSFT', -5)]);

        expect(result.livePositions.map((p) => p.livePrice)).toEqual([100, 100]);
        expect(result.livePositions.every((p) => p.liveTick === undefined)).toBe(true);
    });

    it('matches tick symbols and position tickers case-insensitively', () => {
        const result = deriveLivePortfolioMetrics(portfolioOf(position('aapl'), position('MSFT')), [tick('AAPL', 110), tick('msft', 120)]);

        expect(result.livePositions.map((p) => p.livePrice)).toEqual([110, 120]);
    });
});

describe('survivors: price source and execution rules', () => {
    it('does not treat persisted prices as live or usable', () => {
        expect(isLivePriceSource('persisted')).toBe(false);
        expect(isLivePriceSource('Persisted')).toBe(false);
        expect(isUsablePriceSource('persisted')).toBe(false);
    });

    it('falls back to the average price when no live or persisted price exists', () => {
        expect(getExecutionPriceForPosition({ currentPrice: 0, averagePrice: 100 })).toBe(100);
        expect(getExecutionPriceForPosition({ currentPrice: 0, averagePrice: 100, livePrice: 0 })).toBe(100);
    });

    it('allows selling exactly the held quantity but not zero, negative, or unknown holdings', () => {
        expect(isSellQuantityWithinPosition(10, 10)).toBe(true);
        expect(isSellQuantityWithinPosition(0, 10)).toBe(false);
        expect(isSellQuantityWithinPosition(-1, 10)).toBe(false);
        expect(isSellQuantityWithinPosition(5, undefined)).toBe(false);
        expect(isSellQuantityWithinPosition(5, 0)).toBe(false);
    });
});

describe('survivors: chart history rules', () => {
    it('sorts merged history by time and drops non-finite points', () => {
        const merged = mergeChartHistory(
            [{ price: 12, timestamp: 3, source: 'YahooFinance' }, { price: Number.NaN, timestamp: 1, source: 'YahooFinance' }],
            [{ price: 10, timestamp: 1, source: 'YahooFinance' }, { price: 11, timestamp: Number.POSITIVE_INFINITY, source: 'YahooFinance' }, { price: 11, timestamp: 2, source: 'YahooFinance' }],
            0
        );

        expect(merged.map((point) => point.timestamp)).toEqual([1, 2, 3]);
    });

    it('keeps same-time same-price points from different providers', () => {
        const merged = mergeChartHistory(
            [{ price: 100, timestamp: 1, source: 'YahooFinance' }],
            [{ price: 100, timestamp: 1, source: 'CoinGecko' }, { price: 100, timestamp: 1, source: 'YahooFinance' }],
            0
        );

        expect(merged.map((point) => point.source).sort()).toEqual(['CoinGecko', 'YahooFinance']);
    });

    it('rejects quotes far above the last point but accepts any quote with fewer than two points', () => {
        const history = [{ price: 270, timestamp: 1 }, { price: 280, timestamp: 2 }];

        expect(isQuoteCompatibleWithHistory(400, history)).toBe(false);
        expect(isQuoteCompatibleWithHistory(1000, [{ price: 100, timestamp: 1 }])).toBe(true);
    });
});
