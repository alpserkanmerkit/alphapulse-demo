import { describe, expect, it, vi } from 'vitest';

// Pure-helper tests never render icons; skip the ~100 ms lucide-react barrel import.
vi.mock('lucide-react', () => ({ AlertCircle: () => null, BarChart3: () => null, DollarSign: () => null, RefreshCw: () => null, TrendingDown: () => null, TrendingUp: () => null }));

import { deriveLivePortfolioMetrics, getExecutionPriceForPosition, isLivePriceSource, isQuoteCompatibleWithHistory, isSellQuantityWithinPosition, isStalePriceSource, isUsablePriceSource, mergeChartHistory, PriceTick, shouldShowTimeframeReturn } from '../../pages/PortfolioPage';
import { PortfolioStateModel } from '../../stores/portfolioStore';

// Real axios costs ~190 ms to import per test file and is never exercised here (see helpers/axiosStub.ts).
vi.mock('axios', async () => {
    const { default: axiosStub, AxiosError } = await import('./helpers/axiosStub');
    return { default: axiosStub, AxiosError };
});

const portfolio: PortfolioStateModel = {
    id: 'p1',
    userId: 'u1',
    totalBalance: 100000,
    cashBalance: 90000,
    currentVaR: 0,
    updatedAt: '2026-04-30T12:00:00.000Z',
    positions: [
        {
            id: 'pos1',
            ticker: 'AAPL',
            quantity: 100,
            averagePrice: 100,
            currentPrice: 100,
            updatedAt: '2026-04-30T12:00:00.000Z',
        },
    ],
    transactions: [],
};

const ticks: PriceTick[] = [
    {
        symbol: 'AAPL',
        name: 'Apple Inc.',
        price: 105,
        change24h: 5,
        changePercent24h: 5,
        updatedAt: Date.now(),
        source: 'YahooFinance',
    },
];

describe('deriveLivePortfolioMetrics', () => {
    it('uses live ticks for UI P&L without mutating persisted portfolio prices', () => {
        const result = deriveLivePortfolioMetrics(portfolio, ticks);

        expect(result.livePositions[0].livePrice).toBe(105);
        expect(result.livePositions[0].holdingPnL).toBe(500);
        expect(result.livePnL).toBe(500);
        expect(result.liveEquity).toBe(100500);
        expect(portfolio.positions[0].currentPrice).toBe(100);
    });

    it('ignores simulated ticks for UI P&L and execution pricing', () => {
        const result = deriveLivePortfolioMetrics(portfolio, [{ ...ticks[0], source: 'Simulated', price: 120 }]);

        expect(result.livePositions[0].livePrice).toBe(100);
        expect(result.livePositions[0].liveTick).toBeUndefined();
        expect(result.livePnL).toBe(0);
    });

    it('allows stale provider cache while keeping the source visibly non-live', () => {
        const result = deriveLivePortfolioMetrics(portfolio, [{ ...ticks[0], source: 'stale:YahooFinance', price: 104 }]);

        expect(result.livePositions[0].livePrice).toBe(104);
        expect(result.livePositions[0].liveTick?.source).toBe('stale:YahooFinance');
    });
});

describe('isLivePriceSource', () => {
    it('classifies live, stale, and simulated sources separately', () => {
        expect(isLivePriceSource('Simulated')).toBe(false);
        expect(isLivePriceSource('stale:YahooFinance')).toBe(false);
        expect(isLivePriceSource('YahooFinance')).toBe(true);
        expect(isLivePriceSource('CoinGecko')).toBe(true);
        expect(isLivePriceSource(undefined)).toBe(false);
        expect(isStalePriceSource('stale:YahooFinance')).toBe(true);
        expect(isUsablePriceSource('stale:YahooFinance')).toBe(true);
        expect(isUsablePriceSource('Simulated')).toBe(false);
    });
});

describe('trade prefill helpers', () => {
    it('uses live price before persisted current price and validates sell quantity', () => {
        expect(getExecutionPriceForPosition({ currentPrice: 101, averagePrice: 100, livePrice: 105 })).toBe(105);
        expect(getExecutionPriceForPosition({ currentPrice: 101, averagePrice: 100 })).toBe(101);
        expect(isSellQuantityWithinPosition(5, 10)).toBe(true);
        expect(isSellQuantityWithinPosition(11, 10)).toBe(false);
    });
});

describe('chart history helpers', () => {
    it('keeps full ranged history when limit is disabled', () => {
        const rangedHistory = Array.from({ length: 520 }, (_, index) => ({
            price: 100 + index,
            timestamp: index + 1,
            source: 'YahooFinance',
        }));

        const merged = mergeChartHistory(rangedHistory, [{ price: 700, timestamp: 999, source: 'YahooFinance' }], 0);

        expect(merged).toHaveLength(521);
        expect(merged[0].timestamp).toBe(1);
        expect(merged[520].price).toBe(700);
    });

    it('filters simulated chart ticks and rejects outlier quote overlays', () => {
        const rangedHistory = [
            { price: 270, timestamp: 1, source: 'YahooFinance' },
            { price: 280, timestamp: 2, source: 'YahooFinance' },
        ];

        const merged = mergeChartHistory(rangedHistory, [{ price: 189, timestamp: 3, source: 'Simulated' }], 0);

        expect(merged).toEqual(rangedHistory);
        expect(isQuoteCompatibleWithHistory(189, rangedHistory)).toBe(false);
        expect(isQuoteCompatibleWithHistory(282, rangedHistory)).toBe(true);
    });
});

describe('shouldShowTimeframeReturn', () => {
    it('requires ready ranged history before showing a timeframe return', () => {
        expect(shouldShowTimeframeReturn('loading', [
            { price: 100, timestamp: 1 },
            { price: 101, timestamp: 2 },
        ])).toBe(false);
        expect(shouldShowTimeframeReturn('ready', [{ price: 100, timestamp: 1 }])).toBe(false);
        expect(shouldShowTimeframeReturn('ready', [
            { price: 100, timestamp: 1 },
            { price: 101, timestamp: 2 },
        ])).toBe(true);
    });
});
