import { Router, Request, Response } from 'express';
import { aggregateAllSources, forceRefresh, getFilteredByCategory } from '../services/rssAggregator';
import { getHistoricalPriceResult, getMarketPrices, getPriceHistory, isPriceHistoryRange } from '../services/priceService';
import { buildDataQuality, buildProvenance, buildTelemetry } from '../shared/contracts/responseContracts';
import { isDemoMode } from '../demo/demoMode';
import { DEMO_SOURCE } from '../demo/demoData';

const router = Router();
const DEFAULT_FEED_LIMIT = 3;
const MAX_FEED_LIMIT = 80;

const parseLimit = (value: unknown, fallback = DEFAULT_FEED_LIMIT): number => {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 1), MAX_FEED_LIMIT);
};

const parseSymbols = (value: unknown): string[] =>
    String(value ?? '')
        .split(',')
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean);

const shouldForceRefresh = (value: unknown): boolean => {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true';
};

const isSimulatedSource = (source: string) => ['simulated', DEMO_SOURCE.toLowerCase()].includes(source.toLowerCase());

const priceMode = (sources: string[]) =>
    sources.length === 0 ? 'fallback' as const
        : sources.every(isSimulatedSource) ? 'simulation' as const
            : sources.some((source) => source.toLowerCase() === 'simulated' || source.toLowerCase().startsWith('stale:')) ? 'fallback' as const
                : 'live' as const;

// GET /api/news/feed
// Returns latest aggregated news from all RSS sources
router.get('/feed', async (req: Request, res: Response) => {
    try {
        const limit = parseLimit(req.query.limit);
        if (shouldForceRefresh(req.query.refresh)) {
            forceRefresh();
        }
        const items = await aggregateAllSources();
        const limitedItems = items.slice(0, limit);
        res.json({
            success: true,
            count: limitedItems.length,
            items: limitedItems,
            provenance: buildProvenance({ provider: 'RSS Aggregator', mode: isDemoMode() ? 'simulation' : limitedItems.length > 0 ? 'live' : 'fallback', sourceType: 'news' }),
            dataQuality: buildDataQuality({ status: limitedItems.length > 0 ? 'ready' : 'empty', observations: limitedItems.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (err) {
        console.error('[Route] /news/feed error:', err);
        res.status(500).json({ success: false, error: 'Failed to aggregate news' });
    }
});

// GET /api/news/feed/:category
// Returns news filtered by category
router.get('/feed/:category', async (req: Request, res: Response) => {
    try {
        const category = String(req.params['category'] ?? '');
        const limit = parseLimit(req.query.limit, MAX_FEED_LIMIT);
        const items = await aggregateAllSources();
        const filtered = getFilteredByCategory(items, category.toUpperCase()).slice(0, limit);
        res.json({
            success: true,
            count: filtered.length,
            items: filtered,
            provenance: buildProvenance({ provider: 'RSS Aggregator', mode: isDemoMode() ? 'simulation' : filtered.length > 0 ? 'live' : 'fallback', sourceType: 'news' }),
            dataQuality: buildDataQuality({ status: filtered.length > 0 ? 'ready' : 'empty', observations: filtered.length }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (_err) {
        res.status(500).json({ success: false, error: 'Failed to filter news' });
    }
});

// GET /api/news/prices?symbols=AAPL,BTC
// Returns current market prices with live sources where available.
router.get('/prices', async (req: Request, res: Response) => {
    try {
        const symbols = parseSymbols(req.query.symbols);
        const prices = await getMarketPrices(symbols);
        const sources = prices.map((price) => price.source);
        const mode = priceMode(sources);
        const missingSymbols = symbols.filter((symbol) => !prices.some((price) => price.symbol.toUpperCase() === symbol));
        res.json({
            success: true,
            count: prices.length,
            prices,
            provenance: buildProvenance({
                provider: Array.from(new Set(sources)).join(', ') || 'Price Service',
                mode,
                sourceType: 'market_data',
                degradationReason: mode === 'fallback'
                    ? (prices.length === 0 ? 'market_data_unavailable' : 'stale_quotes_present')
                    : mode === 'simulation' ? 'simulated_quotes_present' : null,
            }),
            dataQuality: buildDataQuality({
                status: prices.length === 0 ? 'empty' : mode === 'live' ? 'ready' : 'degraded',
                observations: prices.length,
                missingSymbols,
            }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (_err) {
        res.status(500).json({ success: false, error: 'Failed to fetch prices' });
    }
});

// GET /api/news/prices/history?symbols=AAPL,NVDA&limit=48
// Returns bounded in-memory price history captured by the price service.
router.get('/prices/history', async (req: Request, res: Response) => {
    try {
        const symbols = parseSymbols(req.query.symbols);
        const range = String(req.query.range ?? '').toUpperCase();
        if (range) {
            if (!isPriceHistoryRange(range)) {
                return res.status(400).json({ success: false, error: 'range must be one of 3M, 6M, 12M, 24M' });
            }
            const result = await getHistoricalPriceResult(symbols, range);
            return res.json({
                success: true,
                symbols: Object.keys(result.history),
                range,
                history: result.history,
                dataQuality: {
                    ...buildDataQuality({
                        status: result.dataQuality.status,
                        observations: result.dataQuality.observations,
                        missingSymbols: result.dataQuality.missingSymbols,
                        errors: result.errors,
                    }),
                    source: result.dataQuality.source,
                },
                errors: result.errors,
                provenance: buildProvenance({
                    provider: result.dataQuality.source,
                    mode: result.dataQuality.source === DEMO_SOURCE ? 'simulation' : result.dataQuality.status === 'ready' ? 'live' : result.dataQuality.status === 'empty' ? 'fallback' : 'fallback',
                    sourceType: 'market_data',
                    degradationReason: Object.keys(result.errors).length > 0 ? 'history_provider_error' : null,
                }),
                telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
            });
        }

        const limit = parseLimit(req.query.limit, 48);
        let history = getPriceHistory(symbols, limit);
        const hasMissingHistory = symbols.length > 0 && symbols.some((symbol) => (history[symbol] ?? []).length === 0);
        if (hasMissingHistory) {
            await getMarketPrices(symbols);
            history = getPriceHistory(symbols, limit);
        }
        const observations = Object.values(history).reduce((total, points) => total + points.length, 0);
        res.json({
            success: true,
            symbols: Object.keys(history),
            history,
            provenance: buildProvenance({ provider: 'InMemoryPriceHistory', mode: 'fallback', sourceType: 'market_data' }),
            dataQuality: buildDataQuality({ status: observations > 0 ? 'degraded' : 'empty', observations }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
        });
    } catch (_err) {
        res.status(500).json({ success: false, error: 'Failed to fetch price history' });
    }
});

export default router;
