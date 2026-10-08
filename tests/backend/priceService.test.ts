import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetPriceServiceForTests, getHistoricalPriceResult, getHistoricalPrices, getMarketPrices, getPriceHistory, recordPriceHistory } from '../../server/services/priceService';

vi.mock('axios', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn(),
    },
}));

const mockedAxios = vi.mocked(axios, true);

describe('price history cache', () => {
    afterEach(() => {
        __resetPriceServiceForTests();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('keeps history ordered and bounded by the requested limit', () => {
        recordPriceHistory([
            { symbol: 'aapl', name: 'Apple Inc.', price: 101, change24h: 0, changePercent24h: 0, currency: 'USD', source: 'YahooFinance', updatedAt: 1 },
            { symbol: 'AAPL', name: 'Apple Inc.', price: 102, change24h: 0, changePercent24h: 0, currency: 'USD', source: 'YahooFinance', updatedAt: 2 },
            { symbol: 'AAPL', name: 'Apple Inc.', price: 103, change24h: 0, changePercent24h: 0, currency: 'USD', source: 'YahooFinance', updatedAt: 3 },
        ]);

        const history = getPriceHistory(['aapl'], 2);

        expect(history.AAPL).toEqual([
            { symbol: 'AAPL', price: 102, timestamp: 2, source: 'YahooFinance' },
            { symbol: 'AAPL', price: 103, timestamp: 3, source: 'YahooFinance' },
        ]);
    });

    it('does not duplicate the same tick', () => {
        const tick = { symbol: 'BTC', name: 'Bitcoin', price: 70000, change24h: 0, changePercent24h: 0, currency: 'USD', source: 'CoinGecko', updatedAt: 10 };

        recordPriceHistory([tick, tick]);

        expect(getPriceHistory(['BTC'], 48).BTC).toHaveLength(1);
    });

    it('does not record simulated or stale fallback ticks into chart history', () => {
        recordPriceHistory([
            { symbol: 'AAPL', name: 'Apple Inc.', price: 101, change24h: 0, changePercent24h: 0, currency: 'USD', source: 'Simulated', updatedAt: 1 },
            { symbol: 'AAPL', name: 'Apple Inc.', price: 102, change24h: 0, changePercent24h: 0, currency: 'USD', source: 'stale:YahooFinance', updatedAt: 2 },
            { symbol: 'AAPL', name: 'Apple Inc.', price: 103, change24h: 0, changePercent24h: 0, currency: 'USD', source: 'YahooFinance', updatedAt: 3 },
        ]);

        expect(getPriceHistory(['AAPL'], 48).AAPL).toEqual([
            { symbol: 'AAPL', price: 103, timestamp: 3, source: 'YahooFinance' },
        ]);
    });
});

describe('market prices', () => {
    afterEach(() => {
        __resetPriceServiceForTests();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('uses the quant yfinance bridge for equity quotes', async () => {
        mockedAxios.get.mockResolvedValue({ data: [] });
        mockedAxios.post.mockResolvedValue({
            data: {
                quotes: [
                    { symbol: 'AAPL', name: 'Apple Inc.', price: 214.12, change24h: 1.2, changePercent24h: 0.56, currency: 'USD', source: 'YahooFinance', updatedAt: 1000 },
                ],
            },
        });

        const prices = await getMarketPrices(['AAPL']);

        expect(prices).toEqual([
            expect.objectContaining({
                symbol: 'AAPL',
                name: 'Apple Inc.',
                price: 214.12,
                change24h: 1.2,
                changePercent24h: 0.56,
                currency: 'USD',
                source: 'YahooFinance',
                updatedAt: 1000,
                providerPolicy: expect.stringContaining('not broker-grade'),
            }),
        ]);
        expect(getPriceHistory(['AAPL']).AAPL).toHaveLength(1);
    });

    it('omits unresolved symbols when the live quote bridge fails', async () => {
        mockedAxios.get.mockResolvedValue({ data: [] });
        mockedAxios.post.mockRejectedValue(new Error('quant down'));

        const prices = await getMarketPrices(['AAPL']);

        expect(prices).toEqual([]);
        expect(getPriceHistory(['AAPL']).AAPL).toEqual([]);
    });

    it('serves latest real history close as stale when the live quote bridge fails', async () => {
        mockedAxios.get.mockResolvedValue({ data: [] });
        mockedAxios.post
            .mockRejectedValueOnce(new Error('quant quote timeout'))
            .mockResolvedValueOnce({
                data: {
                    history: {
                        AAPL: [
                            { symbol: 'AAPL', price: 103, close: 103, timestamp: 1, source: 'YahooFinance', providerPolicy: 'Decision support only; not broker-grade real-time data.' },
                            { symbol: 'AAPL', price: 105, close: 105, timestamp: 2, source: 'YahooFinance', providerPolicy: 'Decision support only; not broker-grade real-time data.' },
                        ],
                    },
                },
            });

        const prices = await getMarketPrices(['AAPL']);

        expect(prices).toEqual([
            expect.objectContaining({
                symbol: 'AAPL',
                name: 'AAPL',
                price: 105,
                change24h: 2,
                source: 'stale:YahooFinance',
                freshnessStatus: 'stale',
                updatedAt: 2,
                providerPolicy: expect.stringContaining('not broker-grade'),
            }),
        ]);
        expect(getPriceHistory(['AAPL']).AAPL).toEqual([]);
    });

    it('serves recent provider cache as stale after a live provider failure', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-04T09:00:00.000Z'));
        mockedAxios.post
            .mockResolvedValueOnce({
                data: {
                    quotes: [
                        { symbol: 'AAPL', name: 'Apple Inc.', price: 214.12, change24h: 1.2, changePercent24h: 0.56, currency: 'USD', source: 'YahooFinance', updatedAt: Date.now() },
                    ],
                },
            })
            .mockRejectedValueOnce(new Error('quant down'));

        await getMarketPrices(['AAPL']);

        vi.setSystemTime(new Date('2026-05-04T09:01:01.000Z'));
        const prices = await getMarketPrices(['AAPL']);

        expect(prices).toHaveLength(1);
        // name/change24h come only from the provider cache entry; the history-close fallback would
        // synthesize name === symbol and a zero change, so these fields prove which path served the quote.
        expect(prices[0]).toEqual(expect.objectContaining({
            symbol: 'AAPL',
            name: 'Apple Inc.',
            price: 214.12,
            change24h: 1.2,
            changePercent24h: 0.56,
            source: 'stale:YahooFinance',
            freshnessStatus: 'stale',
        }));
    });
});

describe('historical market prices', () => {
    afterEach(() => {
        __resetPriceServiceForTests();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('loads ranged YahooFinance history through the quant bridge', async () => {
        mockedAxios.post.mockResolvedValue({
            data: {
                history: {
                    AAPL: [
                        { symbol: 'AAPL', price: 101, open: 99, high: 102, low: 98, close: 101, volume: 123000, timestamp: 3, source: 'YahooFinance', providerPolicy: 'Decision support only; not broker-grade real-time data.', interval: '1d' },
                        { symbol: 'AAPL', price: 100, open: 98, high: 101, low: 97, close: 100, volume: 120000, timestamp: 1, source: 'YahooFinance', providerPolicy: 'Decision support only; not broker-grade real-time data.', interval: '1d' },
                    ],
                },
            },
        });

        const history = await getHistoricalPrices(['aapl'], '24M');

        expect(mockedAxios.post).toHaveBeenCalledWith(
            expect.stringContaining('/api/market/history'),
            { symbols: ['AAPL'], range: '24M' },
            { timeout: 20000 }
        );
        expect(history.AAPL.map((point) => point.timestamp)).toEqual([1, 3]);
        expect(history.AAPL[0]).toEqual(expect.objectContaining({
            open: 98,
            high: 101,
            low: 97,
            close: 100,
            volume: 120000,
            interval: '1d',
        }));
    });

    it('reports degraded data quality when the quant history bridge falls back to in-memory ticks', async () => {
        recordPriceHistory([
            { symbol: 'AAPL', name: 'Apple Inc.', price: 101, change24h: 0, changePercent24h: 0, currency: 'USD', source: 'YahooFinance', updatedAt: 1 },
        ]);
        mockedAxios.post.mockRejectedValue(new Error('quant history down'));

        const result = await getHistoricalPriceResult(['AAPL', 'NVDA'], '3M');

        expect(result.history.AAPL).toHaveLength(1);
        expect(result.history.NVDA).toHaveLength(0);
        expect(result.dataQuality.status).toBe('degraded');
        expect(result.dataQuality.source).toBe('InMemoryFallback');
        expect(result.dataQuality.missingSymbols).toEqual(['AAPL', 'NVDA']);
        expect(result.errors.__root).toContain('quant history down');
    });
});
