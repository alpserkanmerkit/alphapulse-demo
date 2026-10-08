import { requestQuantForecast } from './quantClient';
import { quantCircuitBreaker } from './circuitBreaker';
import { generateQuantFallback, type QuantFallbackResponse } from './quantFallback';
import { getMarketPrices, getPriceBySymbol } from './priceService';

export type QuantForecastHorizon = 'short-term' | 'medium-term' | 'long-term';

export interface QuantForecastInput {
    sentiment_score?: unknown;
    current_price?: unknown;
    risk_free_rate?: unknown;
}

export interface QuantForecastResult {
    payload: Record<string, unknown> | QuantFallbackResponse;
    isFallback: boolean;
    reason: string | null;
}

function toPositiveNumber(value: unknown): number | undefined {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

async function resolveFallbackPrice(ticker: string, currentPrice: unknown): Promise<number | undefined> {
    const requestPrice = toPositiveNumber(currentPrice);
    if (requestPrice) return requestPrice;

    const cachedPrice = getPriceBySymbol(ticker)?.price;
    if (toPositiveNumber(cachedPrice)) return cachedPrice;

    const prices = await getMarketPrices([ticker]).catch(() => []);
    return toPositiveNumber(prices[0]?.price);
}

export async function getQuantForecastWithFallback(
    horizon: QuantForecastHorizon,
    ticker: string,
    input: QuantForecastInput = {},
    timeoutMs = 25000
): Promise<QuantForecastResult> {
    const normalizedTicker = ticker.trim().toUpperCase();

    try {
        const payload = await quantCircuitBreaker.execute(async (signal) => {
            const quantResult = await requestQuantForecast<Record<string, unknown>>(horizon, {
                ticker: normalizedTicker,
                sentiment_score: input.sentiment_score,
                current_price: input.current_price,
                risk_free_rate: input.risk_free_rate,
            }, { timeoutMs, signal });

            if (!quantResult.ok) {
                const statusSuffix = 'statusCode' in quantResult && typeof quantResult.statusCode === 'number' ? ` status=${quantResult.statusCode}` : '';
                throw new Error(`Quant Engine proxy failed reason=${quantResult.reason}${statusSuffix}`);
            }

            return quantResult.data;
        });

        return { payload, isFallback: false, reason: null };
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'quant_unavailable';
        const fallbackPrice = await resolveFallbackPrice(normalizedTicker, input.current_price);
        return {
            payload: generateQuantFallback(horizon, normalizedTicker, fallbackPrice),
            isFallback: true,
            reason,
        };
    }
}
