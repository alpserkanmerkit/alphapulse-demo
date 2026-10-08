/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import { recordProviderCall } from '../shared/observability/runtimeMetrics';
import { providerDisplayLabel, providerFreshnessStatus } from '../shared/providers/providerPolicy';
import { isDemoMode } from '../demo/demoMode';
import { DEMO_SOURCE, getDemoHistory, getDemoPrices } from '../demo/demoData';

export interface PriceTick {
    symbol: string;
    name: string;
    price: number;
    change24h: number;
    changePercent24h: number;
    volume24h?: number;
    marketCap?: number;
    currency: string;
    source: string;
    providerPolicy?: string;
    freshnessStatus?: 'fresh' | 'stale' | 'unknown';
    updatedAt: number;
}

export interface PriceHistoryPoint {
    symbol: string;
    price: number;
    open?: number | null;
    high?: number | null;
    low?: number | null;
    close?: number | null;
    volume?: number | null;
    timestamp: number;
    source: string;
    providerPolicy?: string;
    interval?: string;
}

export type PriceHistoryRange = '3M' | '6M' | '12M' | '24M';
export type PriceHistoryQualityStatus = 'ready' | 'degraded' | 'empty';

export interface HistoricalPriceResult {
    history: Record<string, PriceHistoryPoint[]>;
    errors: Record<string, string>;
    dataQuality: {
        status: PriceHistoryQualityStatus;
        observations: number;
        missingSymbols: string[];
        source: 'QuantHistory' | 'InMemoryFallback' | typeof DEMO_SOURCE;
    };
}

let priceCache: PriceTick[] = [];
let lastPriceFetch = 0;
const PRICE_CACHE_TTL = 60 * 1000;
const STALE_PRICE_TTL = 15 * 60 * 1000;
const PROVIDER_FAILURE_COOLDOWN_MS = 60 * 1000;
const PRICE_HISTORY_LIMIT = 240;
const QUANT_ENGINE_URL = process.env.QUANT_ENGINE_URL || 'http://127.0.0.1:8000';
const priceHistoryCache = new Map<string, PriceHistoryPoint[]>();
const providerFailureCooldowns = new Map<string, number>();

function normalizeSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
}

function isProviderInCooldown(provider: string, symbol: string): boolean {
    const key = `${provider}:${normalizeSymbol(symbol)}`;
    const until = providerFailureCooldowns.get(key) ?? 0;
    if (until <= Date.now()) {
        providerFailureCooldowns.delete(key);
        return false;
    }
    return true;
}

function markProviderFailure(provider: string, symbols: string[]): void {
    const until = Date.now() + PROVIDER_FAILURE_COOLDOWN_MS;
    for (const symbol of symbols.map(normalizeSymbol).filter(Boolean)) {
        providerFailureCooldowns.set(`${provider}:${symbol}`, until);
    }
}

function clearProviderFailure(provider: string, symbols: string[]): void {
    for (const symbol of symbols.map(normalizeSymbol).filter(Boolean)) {
        providerFailureCooldowns.delete(`${provider}:${symbol}`);
    }
}

function isRecordablePriceSource(source?: string): boolean {
    const normalized = source?.toLowerCase() ?? '';
    return Boolean(normalized && normalized !== 'simulated' && normalized !== 'persisted' && !normalized.startsWith('stale:'));
}

function toStaleTick(tick: PriceTick): PriceTick {
    const baseSource = tick.source.startsWith('stale:') ? tick.source.slice('stale:'.length) : tick.source;
    return {
        ...tick,
        source: `stale:${baseSource}`,
        providerPolicy: tick.providerPolicy ?? providerDisplayLabel(baseSource),
        freshnessStatus: 'stale',
    };
}

export function recordPriceHistory(prices: PriceTick[]): void {
    for (const tick of prices) {
        const symbol = normalizeSymbol(tick.symbol);
        if (!symbol || !Number.isFinite(tick.price) || tick.price <= 0 || !isRecordablePriceSource(tick.source)) continue;

        const point: PriceHistoryPoint = {
            symbol,
            price: tick.price,
            timestamp: tick.updatedAt,
            source: tick.source,
        };
        const current = priceHistoryCache.get(symbol) ?? [];
        const last = current[current.length - 1];
        if (last && last.timestamp === point.timestamp && last.price === point.price && last.source === point.source) {
            continue;
        }

        priceHistoryCache.set(symbol, [...current, point].slice(-PRICE_HISTORY_LIMIT));
    }
}

export function getPriceHistory(symbols: string[], limit = 48): Record<string, PriceHistoryPoint[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 48, 1), PRICE_HISTORY_LIMIT);
    const requestedSymbols = symbols.length > 0
        ? Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)))
        : Array.from(priceHistoryCache.keys());

    return requestedSymbols.reduce<Record<string, PriceHistoryPoint[]>>((history, symbol) => {
        history[symbol] = (priceHistoryCache.get(symbol) ?? []).slice(-boundedLimit);
        return history;
    }, {});
}

export function isPriceHistoryRange(value: unknown): value is PriceHistoryRange {
    return value === '3M' || value === '6M' || value === '12M' || value === '24M';
}

const CRYPTO_MARKETS = [
    { id: 'bitcoin', symbol: 'BTC' },
    { id: 'ethereum', symbol: 'ETH' },
    { id: 'solana', symbol: 'SOL' },
    { id: 'binancecoin', symbol: 'BNB' },
    { id: 'ripple', symbol: 'XRP' },
    { id: 'cardano', symbol: 'ADA' },
    { id: 'dogecoin', symbol: 'DOGE' },
    { id: 'avalanche-2', symbol: 'AVAX' },
];

const DEFAULT_MARKET_SYMBOLS = [
    ...CRYPTO_MARKETS.map((market) => market.symbol),
    'AAPL',
    'TSLA',
    'NVDA',
    'MSFT',
    'AMZN',
    'META',
    'GOOGL',
    'JPM',
    'SPX',
    'NDX',
    'VIX',
    'GC=F',
    'CL=F',
    'EURUSD',
    'GBPUSD',
];

async function fetchCryptoPrices(symbols: string[]): Promise<PriceTick[]> {
    const requested = new Set(symbols.map(normalizeSymbol));
    const markets = CRYPTO_MARKETS
        .filter((market) => requested.size === 0 || requested.has(market.symbol))
        .filter((market) => !isProviderInCooldown('CoinGecko', market.symbol));
    if (markets.length === 0) return [];

    const startedAt = Date.now();
    try {
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${markets.map((market) => market.id).join(',')}&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h`;
        const { data } = await axios.get(url, { timeout: 8000 });

        const prices = (data as any[]).map((coin) => ({
            symbol: coin.symbol.toUpperCase(),
            name: coin.name,
            price: coin.current_price,
            change24h: coin.price_change_24h ?? 0,
            changePercent24h: coin.price_change_percentage_24h ?? 0,
            volume24h: coin.total_volume,
            marketCap: coin.market_cap,
            currency: 'USD',
            source: 'CoinGecko',
            providerPolicy: providerDisplayLabel('CoinGecko'),
            freshnessStatus: providerFreshnessStatus('CoinGecko', Date.now()),
            updatedAt: Date.now(),
        }));
        clearProviderFailure('CoinGecko', prices.map((price) => price.symbol));
        recordProviderCall('CoinGecko', Date.now() - startedAt, true);
        return prices;
    } catch (err) {
        console.warn('[Price] CoinGecko failed:', (err as Error).message);
        markProviderFailure('CoinGecko', markets.map((market) => market.symbol));
        recordProviderCall('CoinGecko', Date.now() - startedAt, false);
        return [];
    }
}

function uniqueSymbols(symbols: string[] = []): string[] {
    return Array.from(new Set(symbols.map(normalizeSymbol).filter(Boolean)));
}

function toNullableNumber(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function filterPrices(prices: PriceTick[], symbols: string[]): PriceTick[] {
    if (symbols.length === 0) return prices;
    const requested = new Set(symbols);
    return prices.filter((price) => requested.has(normalizeSymbol(price.symbol)));
}

function mergePriceCache(current: PriceTick[], incoming: PriceTick[]): PriceTick[] {
    const bySymbol = new Map(current.map((tick) => [normalizeSymbol(tick.symbol), tick]));
    for (const tick of incoming) {
        bySymbol.set(normalizeSymbol(tick.symbol), tick);
    }
    return Array.from(bySymbol.values());
}

function canServeFromCache(symbols: string[]): boolean {
    if (priceCache.length === 0) return false;
    if (symbols.length === 0) return true;
    const cachedBySymbol = new Map(priceCache.map((tick) => [normalizeSymbol(tick.symbol), tick]));
    return symbols.every((symbol) => {
        const cached = cachedBySymbol.get(symbol);
        return Boolean(
            cached
            && isRecordablePriceSource(cached.source)
            && Date.now() - cached.updatedAt < PRICE_CACHE_TTL
        );
    });
}

function getStaleCachedPrices(symbols: string[]): PriceTick[] {
    const requested = new Set(symbols.map(normalizeSymbol).filter(Boolean));
    const now = Date.now();
    return priceCache
        .filter((tick) => {
            const symbol = normalizeSymbol(tick.symbol);
            return requested.has(symbol)
                && isRecordablePriceSource(tick.source)
                && now - tick.updatedAt < STALE_PRICE_TTL;
        })
        .map(toStaleTick);
}

async function getHistoricalQuoteFallbacks(symbols: string[]): Promise<PriceTick[]> {
    const requestedSymbols = uniqueSymbols(symbols);
    if (requestedSymbols.length === 0) return [];

    const result = await getHistoricalPriceResult(requestedSymbols, '3M');
    return requestedSymbols.flatMap((symbol) => {
        const points = result.history[symbol] ?? [];
        const latestPoint = points[points.length - 1];
        if (!latestPoint) return [];

        const latestPrice = Number(latestPoint.close ?? latestPoint.price);
        if (!Number.isFinite(latestPrice) || latestPrice <= 0) return [];

        const previousPoint = points.length > 1 ? points[points.length - 2] : undefined;
        const previousPrice = Number(previousPoint?.close ?? previousPoint?.price ?? latestPrice);
        const change24h = Number.isFinite(previousPrice) ? latestPrice - previousPrice : 0;
        const changePercent24h = Number.isFinite(previousPrice) && previousPrice > 0
            ? (change24h / previousPrice) * 100
            : 0;
        const baseSource = latestPoint.source?.startsWith('stale:')
            ? latestPoint.source.slice('stale:'.length)
            : latestPoint.source || 'YahooFinance';

        return [{
            symbol,
            name: symbol,
            price: latestPrice,
            change24h,
            changePercent24h,
            currency: 'USD',
            source: `stale:${baseSource}`,
            providerPolicy: latestPoint.providerPolicy ?? providerDisplayLabel(baseSource),
            freshnessStatus: 'stale' as const,
            updatedAt: latestPoint.timestamp,
        }];
    });
}

async function fetchQuantQuotes(symbols: string[]): Promise<PriceTick[]> {
    const eligibleSymbols = uniqueSymbols(symbols).filter((symbol) => !isProviderInCooldown('YahooFinance', symbol));
    if (eligibleSymbols.length === 0) return [];

    const startedAt = Date.now();
    try {
        const { data } = await axios.post(
            `${QUANT_ENGINE_URL}/api/market/quotes`,
            { symbols: eligibleSymbols },
            { timeout: 10000 }
        );
        const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
        const prices = quotes
            .filter((quote: Partial<PriceTick>) => quote.symbol && Number.isFinite(quote.price))
            .map((quote: Partial<PriceTick>) => ({
                symbol: normalizeSymbol(String(quote.symbol)),
                name: quote.name || String(quote.symbol).toUpperCase(),
                price: Number(quote.price),
                change24h: Number(quote.change24h ?? 0),
                changePercent24h: Number(quote.changePercent24h ?? 0),
                currency: quote.currency || 'USD',
                source: quote.source || 'YahooFinance',
                providerPolicy: providerDisplayLabel(quote.source || 'YahooFinance'),
                freshnessStatus: providerFreshnessStatus(quote.source || 'YahooFinance', Number(quote.updatedAt ?? Date.now())),
                updatedAt: Number(quote.updatedAt ?? Date.now()),
            }));
        clearProviderFailure('YahooFinance', prices.map((price) => price.symbol));
        recordProviderCall('YahooFinance', Date.now() - startedAt, true);
        return prices;
    } catch (err) {
        console.warn('[Price] Quant quote bridge failed:', (err as Error).message);
        markProviderFailure('YahooFinance', eligibleSymbols);
        recordProviderCall('YahooFinance', Date.now() - startedAt, false);
        return [];
    }
}

function buildHistoricalDataQuality(
    requestedSymbols: string[],
    history: Record<string, PriceHistoryPoint[]>,
    source: HistoricalPriceResult['dataQuality']['source'],
    forcedStatus?: PriceHistoryQualityStatus
): HistoricalPriceResult['dataQuality'] {
    const observations = Object.values(history).reduce((total, points) => total + points.length, 0);
    const missingSymbols = requestedSymbols.filter((symbol) => (history[symbol] ?? []).length < 2);
    const status = forcedStatus
        ?? (observations === 0 ? 'empty' : missingSymbols.length > 0 ? 'degraded' : 'ready');

    return { status, observations, missingSymbols, source };
}

export async function getHistoricalPriceResult(symbols: string[], range: PriceHistoryRange): Promise<HistoricalPriceResult> {
    const requestedSymbols = uniqueSymbols(symbols);
    if (requestedSymbols.length === 0) {
        return {
            history: {},
            errors: {},
            dataQuality: { status: 'empty', observations: 0, missingSymbols: [], source: 'QuantHistory' },
        };
    }

    if (isDemoMode()) {
        const history = Object.fromEntries(requestedSymbols.map((symbol) => [symbol, getDemoHistory(symbol, range)]));
        return {
            history,
            errors: {},
            dataQuality: buildHistoricalDataQuality(requestedSymbols, history, DEMO_SOURCE),
        };
    }

    const startedAt = Date.now();
    try {
        const { data } = await axios.post(
            `${QUANT_ENGINE_URL}/api/market/history`,
            { symbols: requestedSymbols, range },
            { timeout: 20000 }
        );
        const history = data?.history && typeof data.history === 'object' ? data.history as Record<string, Partial<PriceHistoryPoint>[]> : {};
        const normalizedHistory = requestedSymbols.reduce<Record<string, PriceHistoryPoint[]>>((result, symbol) => {
            const points = Array.isArray(history[symbol]) ? history[symbol] : [];
            result[symbol] = points
                .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp))
                .map((point) => ({
                    symbol,
                    price: Number(point.price),
                    open: toNullableNumber(point.open),
                    high: toNullableNumber(point.high),
                    low: toNullableNumber(point.low),
                    close: toNullableNumber(point.close) ?? Number(point.price),
                    volume: toNullableNumber(point.volume),
                    timestamp: Number(point.timestamp),
                    source: point.source || 'YahooFinance',
                    providerPolicy: point.providerPolicy || providerDisplayLabel(point.source || 'YahooFinance'),
                    interval: point.interval || '1d',
                }))
                .sort((a, b) => a.timestamp - b.timestamp);
            return result;
        }, {});
        const rawErrors = data?.errors && typeof data.errors === 'object' ? data.errors as Record<string, unknown> : {};
        const errors = Object.fromEntries(Object.entries(rawErrors).map(([symbol, error]) => [normalizeSymbol(symbol), String(error)]));

        recordProviderCall('QuantHistory', Date.now() - startedAt, true);
        return {
            history: normalizedHistory,
            errors,
            dataQuality: buildHistoricalDataQuality(requestedSymbols, normalizedHistory, 'QuantHistory'),
        };
    } catch (err) {
        console.warn('[Price] Quant history bridge failed:', (err as Error).message);
        recordProviderCall('QuantHistory', Date.now() - startedAt, false);
        const fallbackHistory = getPriceHistory(requestedSymbols, 240);
        const hasAnyFallback = Object.values(fallbackHistory).some((points) => points.length > 0);
        return {
            history: fallbackHistory,
            errors: { __root: (err as Error).message },
            dataQuality: buildHistoricalDataQuality(
                requestedSymbols,
                fallbackHistory,
                'InMemoryFallback',
                hasAnyFallback ? 'degraded' : 'empty'
            ),
        };
    }
}

export async function getHistoricalPrices(symbols: string[], range: PriceHistoryRange): Promise<Record<string, PriceHistoryPoint[]>> {
    return (await getHistoricalPriceResult(symbols, range)).history;
}

export async function getMarketPrices(symbols: string[] = []): Promise<PriceTick[]> {
    const requestedSymbols = uniqueSymbols(symbols);
    const targetSymbols = requestedSymbols.length > 0 ? requestedSymbols : DEFAULT_MARKET_SYMBOLS;
    const now = Date.now();

    if (isDemoMode()) {
        priceCache = getDemoPrices(now);
        lastPriceFetch = now;
        recordPriceHistory(priceCache);
        return filterPrices(priceCache, requestedSymbols);
    }

    if (now - lastPriceFetch < PRICE_CACHE_TTL && canServeFromCache(requestedSymbols)) {
        return filterPrices(priceCache, requestedSymbols);
    }

    const supportedCryptoSymbols = new Set(CRYPTO_MARKETS.map((market) => market.symbol));
    const cryptoPrices = await fetchCryptoPrices(targetSymbols.filter((symbol) => supportedCryptoSymbols.has(symbol)));
    const quoteSymbols = targetSymbols.filter((symbol) => !supportedCryptoSymbols.has(symbol));
    const quantQuotes = await fetchQuantQuotes(quoteSymbols);
    const freshSymbols = new Set([...cryptoPrices, ...quantQuotes].map((tick) => normalizeSymbol(tick.symbol)));
    const stalePrices = getStaleCachedPrices(targetSymbols.filter((symbol) => !freshSymbols.has(symbol)));
    const staleSymbols = new Set(stalePrices.map((tick) => normalizeSymbol(tick.symbol)));
    const historicalQuoteFallbacks = requestedSymbols.length > 0
        ? await getHistoricalQuoteFallbacks(quoteSymbols.filter((symbol) => !freshSymbols.has(symbol) && !staleSymbols.has(symbol)))
        : [];
    const nextPrices = [...cryptoPrices, ...quantQuotes];
    priceCache = requestedSymbols.length > 0 ? mergePriceCache(priceCache, nextPrices) : nextPrices;
    lastPriceFetch = now;
    recordPriceHistory(nextPrices);

    console.log(`[Prices] Updated: ${cryptoPrices.length} crypto (CoinGecko) + ${quantQuotes.length} live quotes + ${stalePrices.length} stale cache + ${historicalQuoteFallbacks.length} stale history`);
    return filterPrices([...nextPrices, ...stalePrices, ...historicalQuoteFallbacks], requestedSymbols);
}

export function getPriceBySymbol(symbol: string): PriceTick | undefined {
    return priceCache.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
}

export function __resetPriceServiceForTests(): void {
    priceCache = [];
    lastPriceFetch = 0;
    priceHistoryCache.clear();
    providerFailureCooldowns.clear();
}
