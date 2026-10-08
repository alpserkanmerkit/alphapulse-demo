import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestQuantForecast } from '../../server/services/quantClient';

describe('requestQuantForecast', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('aborts an in-flight forecast request when the caller signal aborts', async () => {
        let fetchSignal: AbortSignal | undefined;
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
            fetchSignal = init?.signal as AbortSignal;
            return new Promise<Response>((_resolve, reject) => {
                fetchSignal?.addEventListener('abort', () => {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, { once: true });
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        // Fake timers keep the 10 s request timeout from firing: the only way the request can be
        // aborted below is by propagating the caller's signal (a real timeout would also yield
        // reason 'timeout' and mask a broken propagation, after a 10 s wait).
        vi.useFakeTimers();
        const controller = new AbortController();
        const forecastPromise = requestQuantForecast('short-term', { ticker: 'AAPL' }, {
            timeoutMs: 10000,
            signal: controller.signal,
        });

        await Promise.resolve();
        expect(fetchSignal?.aborted).toBe(false);
        controller.abort();
        expect(fetchSignal?.aborted).toBe(true);

        await expect(forecastPromise).resolves.toMatchObject({
            ok: false,
            data: null,
            reason: 'timeout',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
