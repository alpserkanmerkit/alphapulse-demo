import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { pathToFileURL } from 'node:url';
import newsRoutes from './routes/newsRoutes';
import aiRoutes from './routes/aiRoutes';
import quantRoutes from './routes/quantRoutes';
import complianceRoutes from './routes/complianceRoutes';
import authRoutes from './routes/authRoutes';
import portfolioRoutes from './routes/portfolioRoutes';
import exportRoutes from './routes/exportRoutes';
import teamRoutes from './routes/teamRoutes';
import opsRoutes from './routes/opsRoutes';
import { demoSeedMiddleware } from './demo/demoSeed';
import { enterDemoMode, isDemoMode, resolveDemoMode } from './demo/demoMode';
import { aggregateAllSources, startAutoRefresh } from './services/rssAggregator';
import { getMarketPrices } from './services/priceService';
import { getComplianceHealth } from './services/complianceRepository';
import { checkQuantHealth } from './services/quantClient';
import { startExportWorker } from './shared/queue/exportWorker';
import { getExportQueueDiagnostics } from './shared/queue/exportQueue';
import { startGarbageCollection } from './jobs/garbageCollector';
import { logRequest, requestContextMiddleware } from './shared/observability/requestContext';
import { getRuntimeMetrics, recordReadiness } from './shared/observability/runtimeMetrics';
import { getProductionConfigStatus } from './shared/config/productionConfig';
import { buildDataQuality, buildProvenance, buildTelemetry } from './shared/contracts/responseContracts';
import { cacheManager } from './shared/cache/cacheManager';
import { getAuditLogStatus } from './shared/audit/auditLog';

const PORT = process.env.SERVER_PORT || 3001;

const getAiMode = () => process.env.GEMINI_API_KEY ? 'live' as const : 'simulation' as const;
const isProductionRuntime = () => process.env.NODE_ENV === 'production';

// Market data reads are throttled by their own, higher-quota limiter instead of the shared /api quota.
// Mount semantics: a path matches itself and any sub-path (segment-aware, like Express app.use).
const MARKET_READ_PATHS = ['/api/news/prices', '/api/news/feed'];

function isMarketReadPath(originalUrl: string): boolean {
    // Express routes case-insensitively by default, so compare the same way.
    const pathname = originalUrl.split('?')[0].toLowerCase();
    return MARKET_READ_PATHS.some((base) => pathname === base || pathname.startsWith(`${base}/`));
}

export function createApp() {
    const app = express();

    app.use(helmet());

    const marketReadLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 1500,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, error: 'Market data requests are temporarily throttled.' },
    });
    app.use(MARKET_READ_PATHS, marketReadLimiter);

    const apiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 300,
        standardHeaders: true,
        legacyHeaders: false,
        message: { success: false, error: 'Too many requests, please try again later.' },
        // Under `app.use('/api/', ...)` req.path has the mount prefix stripped, so the full path
        // is taken from originalUrl (query string removed) to match what marketReadLimiter covers.
        skip: (req) => req.method === 'GET' && isMarketReadPath(req.originalUrl),
    });
    app.use('/api/', apiLimiter);

    app.use(cors({
        origin: process.env.CORS_ORIGINS
            ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim())
            : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-request-id'],
        exposedHeaders: ['x-request-id'],
        credentials: true,
    }));

    app.use(express.json({ limit: '2mb' }));
    app.use(requestContextMiddleware);

    app.use((req, res, next) => {
        res.on('finish', () => {
            logRequest(req, res);
        });
        next();
    });

    if (isDemoMode()) app.use('/api/auth/login', demoSeedMiddleware);
    app.use('/api/news', newsRoutes);
    app.use('/api/ai', aiRoutes);
    app.use('/api/quant', quantRoutes);
    app.use('/api/compliance', complianceRoutes);
    app.use('/api/auth', authRoutes);
    app.use('/api/teams', teamRoutes);
    app.use('/api/portfolio', portfolioRoutes);
    app.use('/api/export', exportRoutes);
    app.use('/api/ops', opsRoutes);

    app.get('/health', async (req, res) => {
        const production = isProductionRuntime();
        const aiMode = getAiMode();
        const quantHealth = await checkQuantHealth();
        const complianceHealth = await getComplianceHealth();

        res.json({
            status: 'ok',
            version: '2.0.0',
            mode: aiMode,
            demo: isDemoMode(),
            services: {
                ai: aiMode,
                quant: quantHealth.status,
                compliance: complianceHealth.status,
            },
            diagnostics: {
                quant: {
                    reason: production ? null : quantHealth.reason,
                    checkedAt: quantHealth.checkedAt,
                },
                compliance: {
                    source: production ? null : complianceHealth.source,
                    reason: production ? null : complianceHealth.reason,
                    loadedAt: production ? null : complianceHealth.loadedAt,
                },
            },
            provenance: buildProvenance({ provider: 'AlphaPulse Runtime', mode: aiMode, sourceType: 'system' }),
            dataQuality: buildDataQuality({
                status: complianceHealth.status === 'unavailable' ? 'degraded' : 'ready',
                observations: 3,
                errors: production ? {} : {
                    ...(quantHealth.reason ? { quant: quantHealth.reason } : {}),
                    ...(complianceHealth.reason ? { compliance: complianceHealth.reason } : {}),
                },
            }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
            timestamp: new Date().toISOString(),
        });
    });

    app.get('/ready', async (req, res) => {
        const production = isProductionRuntime();
        const aiMode = getAiMode();
        const quantHealth = await checkQuantHealth();
        const complianceHealth = await getComplianceHealth();
        const productionConfig = getProductionConfigStatus();
        const ready = complianceHealth.status !== 'unavailable' && productionConfig.ready;
        recordReadiness({
            ready,
            complianceUnavailable: complianceHealth.status === 'unavailable',
            quantUnreachable: quantHealth.status === 'unreachable',
            aiSimulation: aiMode === 'simulation',
        });

        res.status(ready ? 200 : 503).json({
            status: ready ? 'ready' : 'not_ready',
            services: {
                ai: aiMode,
                quant: quantHealth.status,
                compliance: complianceHealth.status,
            },
            ...(production ? {} : { checks: {
                ...productionConfig.checks,
                complianceDataset: complianceHealth.status !== 'unavailable',
            },
            missingProductionConfig: productionConfig.missing,
            operations: {
                cache: cacheManager.diagnostics(),
                exportQueue: getExportQueueDiagnostics(),
                auditLog: getAuditLogStatus(),
            },
            metrics: getRuntimeMetrics() }),
            provenance: buildProvenance({ provider: 'AlphaPulse Runtime', mode: aiMode, sourceType: 'system' }),
            dataQuality: buildDataQuality({
                status: ready ? 'ready' : 'unavailable',
                observations: 3,
                errors: production ? {} : {
                    ...(productionConfig.missing.length > 0 ? { productionConfig: productionConfig.missing.join(',') } : {}),
                    ...(quantHealth.reason ? { quant: quantHealth.reason } : {}),
                    ...(complianceHealth.reason ? { compliance: complianceHealth.reason } : {}),
                },
            }),
            telemetry: buildTelemetry({ requestId: req.requestId ?? null }),
            timestamp: new Date().toISOString(),
        });
    });

    return app;
}

// =============================================
// STARTUP
// =============================================

export async function start() {
    const demoResolution = resolveDemoMode();
    if (demoResolution.demo) enterDemoMode();
    const demo = demoResolution.demo;
    const app = createApp();

    console.log('\n================================================');
    console.log('  ALPHAPULSE INTELLIGENCE SERVER v2.0');
    console.log('================================================');
    if (demo) {
        console.log(`  Mode: DEMO (sample data, no external services${demoResolution.auto ? '; auto: GEMINI_API_KEY missing' : ''})`);
    } else {
        console.log(`  Mode: ${process.env.GEMINI_API_KEY ? 'LIVE (Gemini + Grounding)' : 'SIMULATION (missing GEMINI_API_KEY)'}`);
    }
    console.log(`  Port: ${PORT}`);
    console.log('================================================\n');

    if (!demo) {
        console.log('[Startup] Pre-warming RSS cache...');
        await aggregateAllSources().catch((error) => console.warn('[Startup] RSS pre-warm failed:', error.message));

        console.log('[Startup] Pre-warming price cache...');
        await getMarketPrices().catch((error) => console.warn('[Startup] Price pre-warm failed:', error.message));

        startAutoRefresh();
        startExportWorker();
        startGarbageCollection();
    }

    // The demo is reachable only from the local machine (it has a public demo account).
    app.listen(Number(PORT), demo ? '127.0.0.1' : undefined, () => {
        console.log(`\nAlphaPulse Server ready at http://localhost:${PORT}`);
        console.log('   API endpoints:');
        console.log('   GET  /health                    -> Runtime health and service modes');
        console.log('   GET  /api/news/feed            -> Real-time RSS news');
        console.log('   GET  /api/news/prices          -> Market prices');
        console.log('   GET  /api/compliance/summary   -> Compliance contract snapshot');
        console.log('   POST /api/ai/analyze           -> Fast analysis');
        console.log('   POST /api/ai/deep-dive         -> Deep Dive');
        console.log('   POST /api/ai/debate            -> War Room debate');
        console.log('   POST /api/auth/login           -> JWT authentication');
        console.log('   GET  /api/teams                -> Active user team memberships');
        console.log('   GET  /api/portfolio/state      -> Authenticated portfolio state');
        console.log('   POST /api/export/generate-pdf  -> Optional async export queue');
        console.log('   GET  /api/ops/metrics          -> Admin runtime metrics');
        console.log('   GET  /api/ai/cache-stats       -> Cache status\n');
    });
}

const isDirectRun = process.argv[1]
    ? pathToFileURL(process.argv[1]).href === import.meta.url
    : false;

if (isDirectRun) {
    start().catch(console.error);
}
