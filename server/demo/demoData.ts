// Demo-mode sample data. No external service is called; values are deterministic (fixed seed per symbol),
// so tests and screenshots are stable. Prices are NOT real market data.
import type { RSSNewsItem } from '../services/rssAggregator';
import type { PriceHistoryPoint, PriceHistoryRange, PriceTick } from '../services/priceService';

export const DEMO_SOURCE = 'DemoData';

interface DemoAsset {
    name: string;
    base: number;
    dailyVol: number;
}

const DEMO_ASSETS: Record<string, DemoAsset> = {
    BTC: { name: 'Bitcoin', base: 67250, dailyVol: 0.032 },
    ETH: { name: 'Ethereum', base: 3480, dailyVol: 0.036 },
    SOL: { name: 'Solana', base: 168, dailyVol: 0.048 },
    BNB: { name: 'BNB', base: 592, dailyVol: 0.03 },
    XRP: { name: 'XRP', base: 0.52, dailyVol: 0.04 },
    ADA: { name: 'Cardano', base: 0.46, dailyVol: 0.042 },
    DOGE: { name: 'Dogecoin', base: 0.158, dailyVol: 0.05 },
    AVAX: { name: 'Avalanche', base: 36.4, dailyVol: 0.045 },
    AAPL: { name: 'Apple Inc.', base: 189.5, dailyVol: 0.015 },
    TSLA: { name: 'Tesla Inc.', base: 248.2, dailyVol: 0.03 },
    NVDA: { name: 'NVIDIA Corp.', base: 875.3, dailyVol: 0.028 },
    MSFT: { name: 'Microsoft Corp.', base: 412.1, dailyVol: 0.013 },
    AMZN: { name: 'Amazon.com Inc.', base: 198.5, dailyVol: 0.017 },
    META: { name: 'Meta Platforms', base: 545, dailyVol: 0.02 },
    GOOGL: { name: 'Alphabet Inc.', base: 178.7, dailyVol: 0.016 },
    JPM: { name: 'JPMorgan Chase', base: 198.7, dailyVol: 0.012 },
    SPX: { name: 'S&P 500', base: 5780, dailyVol: 0.009 },
    NDX: { name: 'Nasdaq 100', base: 20150, dailyVol: 0.012 },
    VIX: { name: 'CBOE Volatility Index', base: 18.5, dailyVol: 0.06 },
    'GC=F': { name: 'Gold Futures', base: 2340, dailyVol: 0.009 },
    'CL=F': { name: 'WTI Crude Futures', base: 78.4, dailyVol: 0.02 },
    EURUSD: { name: 'EUR/USD', base: 1.092, dailyVol: 0.004 },
    GBPUSD: { name: 'GBP/USD', base: 1.265, dailyVol: 0.0045 },
};

export const DEMO_SYMBOLS = Object.keys(DEMO_ASSETS);

const DAY_MS = 86_400_000;
const TRADING_POINTS: Record<PriceHistoryRange, number> = { '3M': 63, '6M': 126, '12M': 252, '24M': 504 };
const CALENDAR_DAYS: Record<PriceHistoryRange, number> = { '3M': 90, '6M': 180, '12M': 365, '24M': 730 };

function hashSeed(value: string): number {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function mulberry32(seed: number): () => number {
    let state = seed || 1;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Close series (oldest -> newest); the last value is exactly the base price.
const closeSeriesCache = new Map<string, number[]>();

function closeSeries(symbol: string): number[] {
    const cached = closeSeriesCache.get(symbol);
    if (cached) return cached;

    const asset = DEMO_ASSETS[symbol];
    const random = mulberry32(hashSeed(symbol));
    const length = TRADING_POINTS['24M'];
    const raw: number[] = [1];
    for (let index = 1; index < length; index += 1) {
        const shock = (random() + random() + random() - 1.5) * 2 * asset.dailyVol; // ~N(0, vol)
        raw.push(raw[index - 1] * (1 + shock + 0.0003));
    }
    const scale = asset.base / raw[raw.length - 1];
    const series = raw.map((value) => value * scale);
    closeSeriesCache.set(symbol, series);
    return series;
}

export function getDemoHistory(symbol: string, range: PriceHistoryRange, now = Date.now()): PriceHistoryPoint[] {
    const normalized = symbol.trim().toUpperCase();
    if (!DEMO_ASSETS[normalized]) return [];

    const count = TRADING_POINTS[range];
    const series = closeSeries(normalized).slice(-count);
    const step = (CALENDAR_DAYS[range] * DAY_MS) / count;
    const random = mulberry32(hashSeed(`${normalized}:ohlc`));
    const vol = DEMO_ASSETS[normalized].dailyVol;
    return series.map((close, index) => {
        const open = index === 0 ? close : series[index - 1];
        const high = Math.max(open, close) * (1 + random() * vol * 0.5);
        const low = Math.min(open, close) * (1 - random() * vol * 0.5);
        return {
            symbol: normalized,
            price: close,
            open,
            high,
            low,
            close,
            volume: Math.round(1_000_000 + random() * 4_000_000),
            timestamp: Math.round(now - (count - 1 - index) * step),
            source: DEMO_SOURCE,
            providerPolicy: 'Demo sample data, not a market feed',
            interval: '1d',
        };
    });
}

export function getDemoPrices(now = Date.now()): PriceTick[] {
    return DEMO_SYMBOLS.map((symbol) => {
        const asset = DEMO_ASSETS[symbol];
        const series = closeSeries(symbol);
        const price = series[series.length - 1];
        const previous = series[series.length - 2];
        return {
            symbol,
            name: asset.name,
            price,
            change24h: price - previous,
            changePercent24h: ((price - previous) / previous) * 100,
            currency: 'USD',
            source: DEMO_SOURCE,
            providerPolicy: 'Demo sample data, not a market feed',
            freshnessStatus: 'unknown' as const,
            updatedAt: now,
        };
    });
}

const NEWS_TEMPLATES: Array<Omit<RSSNewsItem, 'id' | 'timestamp' | 'eventId' | 'isAnalyzed' | 'isAnalysing' | 'sourceReliability'> & { reliability: number }> = [
    { headline: 'Nvidia extends AI infrastructure rally as data-center demand beats estimates', category: 'STOCKS', source: 'Demo Markets Wire', urgency: 'HIGH', relatedTickers: ['NVDA'], reliability: 95 },
    { headline: 'Fed officials signal patience on rate cuts as inflation cools unevenly', category: 'MACRO', source: 'Demo Macro Desk', urgency: 'HIGH', relatedTickers: ['SPX'], reliability: 95 },
    { headline: 'Bitcoin holds above key level after spot ETF inflows return', category: 'CRYPTO', source: 'Demo Crypto Ledger', urgency: 'MEDIUM', relatedTickers: ['BTC'], reliability: 80 },
    { headline: 'Apple supplier checks point to steady iPhone build plans for next quarter', category: 'STOCKS', source: 'Demo Markets Wire', urgency: 'MEDIUM', relatedTickers: ['AAPL'], reliability: 80 },
    { headline: 'Oil edges higher as OPEC+ discussion keeps supply risk premium in play', category: 'COMMODITIES', source: 'Demo Energy Brief', urgency: 'MEDIUM', relatedTickers: ['CL=F'], reliability: 80 },
    { headline: 'Gold steadies near record territory as real yields soften', category: 'COMMODITIES', source: 'Demo Energy Brief', urgency: 'LOW', relatedTickers: ['GC=F'], reliability: 80 },
    { headline: 'Tesla deliveries preview: analysts trim estimates ahead of earnings', category: 'STOCKS', source: 'Demo Markets Wire', urgency: 'MEDIUM', relatedTickers: ['TSLA'], reliability: 80 },
    { headline: 'Ethereum developers schedule next network upgrade for testnet', category: 'CRYPTO', source: 'Demo Crypto Ledger', urgency: 'LOW', relatedTickers: ['ETH'], reliability: 65 },
    { headline: 'Dollar softens against euro as eurozone growth data surprises to the upside', category: 'FOREX', source: 'Demo Macro Desk', urgency: 'MEDIUM', relatedTickers: ['EURUSD'], reliability: 80 },
    { headline: 'Microsoft expands cloud AI partnerships with new enterprise agreements', category: 'STARTUP', source: 'Demo Tech Pulse', urgency: 'LOW', relatedTickers: ['MSFT'], reliability: 65 },
    { headline: 'JPMorgan sees resilient consumer credit as delinquencies stay contained', category: 'STOCKS', source: 'Demo Markets Wire', urgency: 'LOW', relatedTickers: ['JPM'], reliability: 80 },
    { headline: 'Volatility index drifts lower as equity breadth improves', category: 'MACRO', source: 'Demo Macro Desk', urgency: 'LOW', relatedTickers: ['VIX', 'SPX'], reliability: 80 },
];

export function getDemoNews(now = Date.now()): RSSNewsItem[] {
    return NEWS_TEMPLATES.map(({ reliability, ...template }, index) => ({
        ...template,
        id: `demo-news-${index + 1}`,
        timestamp: now - (index + 1) * 17 * 60_000,
        sourceReliability: reliability,
        eventId: `demo-evt-${index + 1}`,
        isAnalyzed: false,
        isAnalysing: false,
    }));
}
