import RSSParser from 'rss-parser';
import { Category, MarketEvent } from '../../types';
import { isDemoMode } from '../demo/demoMode';
import { getDemoNews } from '../demo/demoData';

// =============================================
// RSS FEED SOURCES — Expanded & Reliable
// =============================================

interface RSSSource {
    name: string;
    url: string;
    category: Category;
    priority: number;
    maxItems?: number;
}

const RSS_SOURCES: RSSSource[] = [
    // === STOCKS ===
    { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', category: Category.STOCKS, priority: 1, maxItems: 10 },
    { name: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/realtimeheadlines', category: Category.STOCKS, priority: 1, maxItems: 8 },
    { name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml', category: Category.STOCKS, priority: 2, maxItems: 6 },
    { name: 'Nasdaq', url: 'https://www.nasdaq.com/feed/rssoutbound?category=Markets', category: Category.STOCKS, priority: 2, maxItems: 6 },
    // { name: 'Investopedia', url: 'https://www.investopedia.com/feedbuilder/feed/getfeed/?feedName=rss_headline', category: Category.STOCKS, priority: 3, maxItems: 5 }, // [FIXED] 404 Not Found
    // === CRYPTO ===
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: Category.CRYPTO, priority: 1, maxItems: 10 },
    { name: 'CoinTelegraph', url: 'https://cointelegraph.com/rss', category: Category.CRYPTO, priority: 1, maxItems: 8 },
    { name: 'Decrypt', url: 'https://decrypt.co/feed', category: Category.CRYPTO, priority: 2, maxItems: 6 },
    { name: 'Bitcoin Magazine', url: 'https://bitcoinmagazine.com/.rss/full/', category: Category.CRYPTO, priority: 2, maxItems: 5 },
    { name: 'The Block', url: 'https://www.theblock.co/rss.xml', category: Category.CRYPTO, priority: 2, maxItems: 5 },
    // === MACRO / GLOBAL ===
    { name: 'Bloomberg Markets', url: 'https://feeds.bloomberg.com/markets/news.rss', category: Category.MACRO, priority: 1, maxItems: 8 },
    { name: 'Investing.com', url: 'https://www.investing.com/rss/news.rss', category: Category.MACRO, priority: 2, maxItems: 6 },
    { name: 'Financial Post', url: 'https://financialpost.com/feed', category: Category.MACRO, priority: 3, maxItems: 5 },
    // === FOREX / RATES ===
    // { name: 'FXStreet', url: 'https://www.fxstreet.com/rss/news', category: Category.FOREX, priority: 2, maxItems: 5 }, // [FIXED] TLS Socket Disconnect
    // { name: 'DailyFX', url: 'https://www.dailyfx.com/feeds/all', category: Category.FOREX, priority: 2, maxItems: 5 }, // [FIXED] 403 Forbidden
    // === COMMODITIES ===
    { name: 'Oil Price', url: 'https://oilprice.com/rss/main', category: Category.COMMODITIES, priority: 2, maxItems: 5 },
    // { name: 'Kitco Gold', url: 'https://www.kitco.com/rss/news/news.rss', category: Category.COMMODITIES, priority: 2, maxItems: 4 }, // [FIXED] 404 Not Found
    // === STARTUP / TECH ===
    { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: Category.STARTUP, priority: 1, maxItems: 8 },
    { name: 'VentureBeat', url: 'https://feeds.feedburner.com/venturebeat/SZYF', category: Category.STARTUP, priority: 2, maxItems: 5 },
    { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: Category.STARTUP, priority: 3, maxItems: 4 },
];

// =============================================
// CATEGORY AUTO-DETECTION
// =============================================

const CATEGORY_KEYWORDS: Record<string, Category> = {
    bitcoin: Category.CRYPTO, btc: Category.CRYPTO, ethereum: Category.CRYPTO,
    eth: Category.CRYPTO, crypto: Category.CRYPTO, blockchain: Category.CRYPTO,
    defi: Category.CRYPTO, nft: Category.CRYPTO, solana: Category.CRYPTO,
    altcoin: Category.CRYPTO, binance: Category.CRYPTO, coinbase: Category.CRYPTO,
    'interest rate': Category.FOREX, dollar: Category.FOREX, 'usd/': Category.FOREX,
    'eur/': Category.FOREX, currency: Category.FOREX, forex: Category.FOREX,
    gold: Category.COMMODITIES, oil: Category.COMMODITIES, silver: Category.COMMODITIES,
    commodity: Category.COMMODITIES, crude: Category.COMMODITIES, wti: Category.COMMODITIES,
    brent: Category.COMMODITIES, 'natural gas': Category.COMMODITIES,
    startup: Category.STARTUP, venture: Category.STARTUP, 'ai model': Category.STARTUP,
    openai: Category.STARTUP, anthropic: Category.STARTUP, 'series a': Category.STARTUP,
    'series b': Category.STARTUP, fundraise: Category.STARTUP,
    fed: Category.MACRO, gdp: Category.MACRO, inflation: Category.MACRO,
    recession: Category.MACRO, 'central bank': Category.MACRO, 'trade war': Category.MACRO,
    'rate hike': Category.MACRO, geopolit: Category.MACRO,
};

function detectCategory(headline: string, defaultCategory: Category): Category {
    const lower = headline.toLowerCase();
    for (const [keyword, category] of Object.entries(CATEGORY_KEYWORDS)) {
        if (lower.includes(keyword)) return category;
    }
    return defaultCategory;
}

function detectUrgency(headline: string): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const lower = headline.toLowerCase();
    const critical = ['crash', 'collapse', 'emergency', 'black swan', 'bankrupt', 'plunge 2', 'crisis'];
    const high = ['rate hike', 'fed decision', 'earnings miss', 'earnings beat', 'merger', 'acquisition', 'ban', 'halt'];
    const medium = ['report', 'forecast', 'analyst', 'upgrade', 'downgrade', 'gdp', 'inflation'];
    if (critical.some((w) => lower.includes(w))) return 'CRITICAL';
    if (high.some((w) => lower.includes(w))) return 'HIGH';
    if (medium.some((w) => lower.includes(w))) return 'MEDIUM';
    return 'LOW';
}

function extractTickers(headline: string): string[] {
    const known: Record<string, string> = {
        apple: 'AAPL', tesla: 'TSLA', nvidia: 'NVDA', microsoft: 'MSFT',
        amazon: 'AMZN', google: 'GOOGL', alphabet: 'GOOGL', meta: 'META',
        'jp morgan': 'JPM', jpmorgan: 'JPM', bitcoin: 'BTC', ethereum: 'ETH',
        solana: 'SOL', coinbase: 'COIN', 'bank of america': 'BAC',
        's&p': 'SPX', nasdaq: 'NDX', gold: 'XAU', oil: 'OIL', openai: 'MSFT',
    };
    const lower = headline.toLowerCase();
    const tickers: string[] = [];
    for (const [name, ticker] of Object.entries(known)) {
        if (lower.includes(name)) tickers.push(ticker);
    }
    const inline = Array.from(headline.matchAll(/\$([A-Z]{1,5})/g)).map((m) => m[1]);
    return [...new Set([...tickers, ...inline])].slice(0, 4);
}

// =============================================
// DEDUPLICATION
// =============================================

const seenHeadlines = new Set<string>();
const MAX_SEEN = 3000;

function isDuplicate(headline: string): boolean {
    const key = headline
        .toLowerCase()
        .replaceAll(/[^a-z0-9]/g, '')
        .slice(0, 80);
    if (seenHeadlines.has(key)) return true;
    seenHeadlines.add(key);
    if (seenHeadlines.size > MAX_SEEN) {
        const first = seenHeadlines.values().next().value;
        if (first) seenHeadlines.delete(first);
    }
    return false;
}

// =============================================
// TYPES
// =============================================

export interface RSSNewsItem {
    id: string;
    headline: string;
    timestamp: number;
    category: string;
    source: string;
    sourceReliability: number;
    urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    relatedTickers: string[];
    url?: string;
    isAnalyzed: boolean;
    isAnalysing: boolean;
    eventId?: string;
}

// =============================================
// PARSER
// =============================================

const parser = new RSSParser({
    timeout: 10000,
    headers: {
        'User-Agent': 'AlphaPulse-Terminal/2.0 (Financial Intelligence Research)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
    },
    customFields: { item: ['media:thumbnail'] },
});

// =============================================
// FETCH SINGLE SOURCE (with retry & circuit breaker)
// =============================================

const circuitBreakerStats = new Map<string, { failures: number, lastFailure: number }>();
const MAX_FAILURES = 3;
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes cooldown

async function fetchSource(source: RSSSource): Promise<RSSNewsItem[]> {
    const stat = circuitBreakerStats.get(source.url) || { failures: 0, lastFailure: 0 };
    
    if (stat.failures >= MAX_FAILURES) {
        if (Date.now() - stat.lastFailure < COOLDOWN_MS) {
            console.warn(`[RSS] 🛑 Circuit Breaker OPEN for ${source.name} - skipping to prevent bans`);
            return [];
        } else {
            stat.failures = 0; // cooldown elapsed, try again
        }
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const feed = await parser.parseURL(source.url);
            const items: RSSNewsItem[] = [];
            const limit = source.maxItems ?? 8;

            const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 Days
            const now = Date.now();
            const currentYear = new Date().getFullYear();

            for (const item of (feed.items || []).slice(0, limit)) {
                const headline = item.title?.trim();
                if (!headline || isDuplicate(headline)) continue;

                // --- TEMPORAL SEMANTIC RELEVANCE FILTER ---
                const itemTimestamp = item.pubDate ? new Date(item.pubDate).getTime() : now;
                const ageMs = now - itemTimestamp;
                
                // If strictly older than 30 days...
                if (ageMs > MAX_AGE_MS) {
                    const lowerHeadline = headline.toLowerCase();
                    // "Semantic Rescue": Check if it projects into the future or contains strategic long-term actions
                    const futureKeywords = [
                        (currentYear + 1).toString(), (currentYear + 2).toString(),
                        'contract', 'agreement', 'merger', 'acquisition', 'buyout',
                        'q1', 'q2', 'q3', 'q4', 'launch', 'construction', 'projected',
                        'sözleşme', 'birleşme', 'satın alma'
                    ];
                    
                    const isFuturisticOrStrategic = futureKeywords.some(kw => lowerHeadline.includes(kw));

                    if (!isFuturisticOrStrategic) {
                        // It's old and doesn't project value to the current state -> Discard
                        continue;
                    } else {
                        console.log(`[RSS] 🔮 Semantic Rescue Applied: Kept older strategic news '${headline.substring(0,40)}...'`);
                    }
                }
                // ------------------------------------------

                items.push({
                    id: `rss-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    headline,
                    timestamp: itemTimestamp,
                    category: detectCategory(headline, source.category),
                    source: source.name,
                    sourceReliability: source.priority === 1 ? 95 : source.priority === 2 ? 80 : 65,
                    urgency: detectUrgency(headline),
                    relatedTickers: extractTickers(headline),
                    url: item.link,
                    isAnalyzed: false,
                    isAnalysing: false,
                });
            }

            // Success: Reset circuit breaker stats
            if (stat.failures > 0) {
                stat.failures = 0;
                circuitBreakerStats.set(source.url, stat);
            }
            
            return items;
        } catch (_err) {
            if (attempt === 2) {
                stat.failures++;
                stat.lastFailure = Date.now();
                circuitBreakerStats.set(source.url, stat);
                console.warn(`[RSS] ✗ ${source.name} failed. Tripped ${stat.failures}/${MAX_FAILURES}`);
            }
            // Wait 500ms before intra-fetch retry
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    return [];
}

// =============================================
// AGGREGATOR
// =============================================

let cachedNews: RSSNewsItem[] = [];
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const TARGET_ITEMS = 80;

export async function aggregateAllSources(): Promise<RSSNewsItem[]> {
    if (isDemoMode()) return getDemoNews();

    const now = Date.now();
    if (now - lastFetchTime < CACHE_TTL && cachedNews.length > 0) {
        return cachedNews;
    }

    console.log(`[RSS] Fetching from ${RSS_SOURCES.length} sources...`);
    const results = await Promise.allSettled(RSS_SOURCES.map(fetchSource));

    const allItems: RSSNewsItem[] = [];
    let successCount = 0;
    results.forEach((result, _i) => {
        if (result.status === 'fulfilled' && result.value.length > 0) {
            successCount++;
            allItems.push(...result.value);
        }
    });

    // Sort newest first
    allItems.sort((a, b) => b.timestamp - a.timestamp);

    // ==========================================
    // SIMPLE EVENT CLUSTERING ALGORITHM
    // ==========================================
    const events: MarketEvent[] = [];
    allItems.forEach((item) => {
        const keywords = item.headline.toLowerCase().split(/\W+/).filter((w) => w.length > 4);
        const tickers = item.relatedTickers || [];

        const matchedEvent = events.find((e) => {
            // Time proximity check: within 12 hours
            if (Math.abs(e.timestamp - item.timestamp) > 12 * 60 * 60 * 1000) return false;
            
            // Match by Ticker
            if (tickers.length > 0) {
                const eTickers = allItems.find(x => x.id === e.relatedNewsIds[0])?.relatedTickers || [];
                if (tickers.some(t => eTickers.includes(t))) return true;
            }

            // Match by Keywords (at least 2 overlapping long words)
            const eKeywords = e.headline.toLowerCase().split(/\W+/).filter(w => w.length > 4);
            const overlap = keywords.filter(k => eKeywords.includes(k));
            return overlap.length >= 2;
        });

        if (matchedEvent) {
            matchedEvent.relatedNewsIds.push(item.id);
            item.eventId = matchedEvent.id;
        } else {
            const newEventId = `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            events.push({
                id: newEventId,
                headline: item.headline,
                relatedNewsIds: [item.id],
                timestamp: item.timestamp,
            });
            item.eventId = newEventId;
        }
    });

    cachedNews = allItems.slice(0, TARGET_ITEMS);
    lastFetchTime = now;

    console.log(`[RSS] ✓ ${cachedNews.length} items grouped into ${events.length} events from ${successCount}/${RSS_SOURCES.length} sources`);
    return cachedNews;
}

export function getFilteredByCategory(items: RSSNewsItem[], category: string): RSSNewsItem[] {
    if (category === 'ALL' || !category) return items;
    return items.filter((item) => item.category === category);
}

export function forceRefresh(): void {
    lastFetchTime = 0;
    seenHeadlines.clear();
}

export function getCachedNewsSnapshot(): RSSNewsItem[] {
    return cachedNews.slice();
}

export function startAutoRefresh(): void {
    setInterval(async () => {
        forceRefresh();
        await aggregateAllSources();
    }, CACHE_TTL);
}
