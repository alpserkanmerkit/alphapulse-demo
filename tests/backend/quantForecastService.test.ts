import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    requestQuantForecast: vi.fn(),
    getMarketPrices: vi.fn(),
    getPriceBySymbol: vi.fn(),
}));

vi.mock('../../server/services/quantClient', () => ({
    requestQuantForecast: mocks.requestQuantForecast,
}));

vi.mock('../../server/services/priceService', () => ({
    getMarketPrices: mocks.getMarketPrices,
    getPriceBySymbol: mocks.getPriceBySymbol,
}));

import { getQuantForecastWithFallback } from '../../server/services/quantForecastService';

describe('getQuantForecastWithFallback', () => {
    beforeEach(() => {
        mocks.requestQuantForecast.mockReset();
        mocks.getMarketPrices.mockReset();
        mocks.getPriceBySymbol.mockReset();
    });

    it('passes the circuit breaker abort signal and timeout to the quant client', async () => {
        mocks.requestQuantForecast.mockResolvedValue({
            ok: true,
            data: { data: { ticker: 'AAPL', current_price: 100 } },
        });

        const result = await getQuantForecastWithFallback('short-term', 'aapl', {
            risk_free_rate: 0.04,
        }, 1234);

        expect(result).toMatchObject({ isFallback: false, reason: null });
        expect(mocks.requestQuantForecast).toHaveBeenCalledTimes(1);
        const [horizon, body, options] = mocks.requestQuantForecast.mock.calls[0];
        expect(horizon).toBe('short-term');
        expect(body).toMatchObject({
            ticker: 'AAPL',
            risk_free_rate: 0.04,
        });
        expect(options).toMatchObject({ timeoutMs: 1234 });
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.signal.aborted).toBe(false);
    });
});
