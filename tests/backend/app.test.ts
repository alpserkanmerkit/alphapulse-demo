import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBackendTestServer } from './testServer';

const defaultDatasetPath = path.join(process.cwd(), 'server/data/compliance-snapshot.json');
const missingDatasetPath = path.join(process.cwd(), 'server/data/missing-fixture.json');

async function withServer(
    quantStatus: { status: 'reachable' | 'unreachable'; reason: string | null; checkedAt: string },
    handler: (baseUrl: string) => Promise<void>
) {
    await withBackendTestServer(handler, {
        beforeImport: () => {
            vi.doMock('../../server/services/quantClient', () => ({
                checkQuantHealth: vi.fn().mockResolvedValue(quantStatus),
                requestQuantForecast: vi.fn().mockResolvedValue({ ok: false, data: null }),
            }));
        },
        restoreDatabaseUrlBeforeHandler: true,
        seedComplianceDatasetPath: defaultDatasetPath,
    });
}

// F-2: /api/auth/register returns a uniform 202 (no token); after registering, sign in with the same credentials.
async function registerAndLogin(baseUrl: string, init: RequestInit): Promise<Response> {
    const registerResponse = await fetch(`${baseUrl}/api/auth/register`, init);
    expect(registerResponse.status).toBe(202);
    return fetch(`${baseUrl}/api/auth/login`, init);
}

async function registerAuthHeaders(baseUrl: string, email: string) {
    const response = await registerAndLogin(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'password123' }),
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.token).toEqual(expect.any(String));

    return {
        token: payload.token as string,
        user: payload.user,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${payload.token}`,
        },
    };
}

describe('backend contracts', () => {
    beforeEach(() => {
        process.env.NODE_ENV = 'test';
        process.env.GEMINI_API_KEY = '';
        process.env.COMPLIANCE_DATASET_PATH = defaultDatasetPath;
        delete process.env.JWT_SECRET;
        delete process.env.CORS_ORIGINS;
        delete process.env.DATABASE_URL;
        delete process.env.QUANT_ENGINE_URL;
        delete process.env.REDIS_URL;
        delete process.env.PDF_EXPORT_ENABLED;
        delete process.env.REQUIRE_DURABLE_CACHE;
    });

    afterEach(() => {
        delete process.env.NODE_ENV;
        delete process.env.GEMINI_API_KEY;
        delete process.env.COMPLIANCE_DATASET_PATH;
        delete process.env.JWT_SECRET;
        delete process.env.CORS_ORIGINS;
        delete process.env.DATABASE_URL;
        delete process.env.QUANT_ENGINE_URL;
        delete process.env.REDIS_URL;
        delete process.env.PDF_EXPORT_ENABLED;
        delete process.env.REQUIRE_DURABLE_CACHE;
        vi.doUnmock('@google/genai');
        vi.doUnmock('../../server/services/priceService');
        vi.doUnmock('../../server/services/rssAggregator');
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('returns health with reachable quant and ready compliance', async () => {
        await withServer(
            { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/health`, { headers: { 'x-request-id': 'test-request-1' } });
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(response.headers.get('x-request-id')).toBe('test-request-1');
                expect(payload.services.quant).toBe('reachable');
                expect(payload.services.compliance).toBe('ready');
                expect(payload.diagnostics.compliance.source).toBe('local-file');
                expect(payload.provenance.sourceType).toBe('system');
                expect(payload.dataQuality.status).toBe('ready');
                expect(payload.telemetry.requestId).toBe('test-request-1');
            }
        );
    });

    it('keeps production health shape stable while redacting diagnostics', async () => {
        process.env.NODE_ENV = 'production';

        await withServer(
            { status: 'unreachable', reason: 'connection_refused', checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/health`);
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(payload.services.quant).toBe('unreachable');
                expect(payload.diagnostics.quant.reason).toBeNull();
                expect(payload.diagnostics.compliance.source).toBeNull();
                expect(payload.diagnostics.compliance.reason).toBeNull();
                expect(payload.dataQuality.errors).toEqual({});
            }
        );
    });

    it('returns readiness diagnostics with institutional metadata', async () => {
        await withServer(
            { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/ready`);
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(payload.status).toBe('ready');
                expect(payload.checks.jwtSecret).toBe(true);
                expect(payload.checks.databaseUrl).toBe(true);
                expect(payload.checks.redisForExport).toBe(true);
                expect(payload.checks.durableCache).toBe(true);
                expect(payload.missingProductionConfig).toEqual([]);
                expect(payload.operations.cache.backend).toBe('memory');
                expect(payload.operations.exportQueue.mode).toBe('disabled');
                expect(payload.operations.auditLog.mode).toBe('db_primary_file_fallback');
                expect(payload.metrics.readiness.total).toBeGreaterThanOrEqual(1);
                expect(payload.metrics.ai.simulationMode).toBeGreaterThanOrEqual(1);
                expect(payload.provenance.sourceType).toBe('system');
                expect(payload.dataQuality.status).toBe('ready');
            }
        );
    });

    it('fails readiness when production config is incomplete', async () => {
        process.env.NODE_ENV = 'production';
        delete process.env.JWT_SECRET;
        delete process.env.CORS_ORIGINS;
        delete process.env.DATABASE_URL;
        delete process.env.QUANT_ENGINE_URL;

        await withServer(
            { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/ready`);
                const payload = await response.json();

                expect(response.status).toBe(503);
                expect(payload.status).toBe('not_ready');
                expect(payload.checks).toBeUndefined();
                expect(payload.missingProductionConfig).toBeUndefined();
                expect(payload.operations).toBeUndefined();
                expect(payload.metrics).toBeUndefined();
                expect(payload.dataQuality.errors).toEqual({});
                expect(payload.dataQuality.status).toBe('unavailable');
            }
        );
    });

    it('requires Redis when production export or durable cache is explicitly enabled', async () => {
        // Each flag is exercised on its own (plus a flags-off control) so that dropping either Redis
        // requirement - or an unrelated reason for 503 - cannot hide behind the other flag.
        const cases: Array<{ flags: Record<string, string>; status: number }> = [
            { flags: {}, status: 200 },
            { flags: { PDF_EXPORT_ENABLED: 'true' }, status: 503 },
            { flags: { REQUIRE_DURABLE_CACHE: 'true' }, status: 503 },
        ];

        for (const { flags, status } of cases) {
            process.env.NODE_ENV = 'production';
            process.env.JWT_SECRET = 'test-secret';
            process.env.CORS_ORIGINS = 'https://app.example.com';
            process.env.DATABASE_URL = 'file:./prisma/prod.db';
            process.env.QUANT_ENGINE_URL = 'http://quant.example.com';
            delete process.env.PDF_EXPORT_ENABLED;
            delete process.env.REQUIRE_DURABLE_CACHE;
            delete process.env.REDIS_URL;
            Object.assign(process.env, flags);

            await withServer(
                { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
                async (baseUrl) => {
                    const response = await fetch(`${baseUrl}/ready`);
                    const payload = await response.json();

                    expect(response.status, JSON.stringify(flags)).toBe(status);
                    expect(payload.checks).toBeUndefined();
                    expect(payload.missingProductionConfig).toBeUndefined();
                    expect(payload.operations).toBeUndefined();
                    expect(payload.metrics).toBeUndefined();
                    expect(payload.dataQuality.errors).toEqual({});
                }
            );
        }
    });

    it('allows Vite preview origin through default CORS settings', async () => {
        await withServer(
            { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/health`, {
                    headers: { Origin: 'http://127.0.0.1:4173' },
                });

                expect(response.status).toBe(200);
                expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:4173');
            }
        );
    });

    it('requires authentication for protected intelligence APIs', async () => {
        await withServer(
            { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const complianceResponse = await fetch(`${baseUrl}/api/compliance/summary`);
                expect(complianceResponse.status).toBe(401);

                const aiResponse = await fetch(`${baseUrl}/api/ai/analyze`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ headline: 'AMD expands data center roadmap' }),
                });
                expect(aiResponse.status).toBe(401);

                const quantResponse = await fetch(`${baseUrl}/api/quant/short-term`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ticker: 'AAPL', current_price: 100 }),
                });
                expect(quantResponse.status).toBe(401);
            }
        );
    });

    it('returns compliance summary from the DB-primary governance snapshot', async () => {
        await withServer(
            { status: 'unreachable', reason: 'connection_refused', checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const { headers } = await registerAuthHeaders(baseUrl, 'summary@example.com');
                const response = await fetch(`${baseUrl}/api/compliance/summary`, { headers });
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(payload.version).toBe(2);
                expect(payload.restricted).toHaveLength(3);
                expect(payload.pendingApprovals).toEqual([]);
                expect(payload.provenance.sourceType).toBe('compliance');
                expect(payload.dataQuality.status).toBe('ready');
            }
        );
    });

    it('keeps compliance ready from DB primary when the seed dataset path is missing', async () => {
        process.env.COMPLIANCE_DATASET_PATH = missingDatasetPath;

        await withServer(
            { status: 'unreachable', reason: 'connection_refused', checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/health`);
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(payload.services.compliance).toBe('ready');
                expect(payload.diagnostics.compliance.reason).toBeNull();
            }
        );
    });

    it('continues analyze requests when DB compliance coverage is available and the seed file is missing', async () => {
        process.env.COMPLIANCE_DATASET_PATH = missingDatasetPath;

        await withServer(
            { status: 'unreachable', reason: 'connection_refused', checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const { headers } = await registerAuthHeaders(baseUrl, 'missing-ai@example.com');
                const response = await fetch(`${baseUrl}/api/ai/analyze`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ headline: 'Nvidia rallies on new AI demand' }),
                });
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(payload.success).toBe(true);
                expect(payload.provenance.sourceType).toBe('ai');
            }
        );
    });

    it('blocks restricted tickers with COMPLIANCE_BLOCK', async () => {
        await withServer(
            { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const { headers } = await registerAuthHeaders(baseUrl, 'restricted@example.com');
                const response = await fetch(`${baseUrl}/api/ai/analyze`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ headline: 'XYZ Corp extends merger talks' }),
                });
                const payload = await response.json();

                expect(response.status).toBe(403);
                expect(payload.error).toBe('COMPLIANCE_BLOCK');
            }
        );
    });

    it('returns simulation analysis telemetry when GEMINI_API_KEY is missing', async () => {
        await withServer(
            { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const { headers } = await registerAuthHeaders(baseUrl, 'simulation@example.com');
                const response = await fetch(`${baseUrl}/api/ai/analyze`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ headline: 'AMD expands data center roadmap' }),
                });
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(payload.mode).toBe('simulation');
                expect(payload.reason).toBe('ai_simulation');
                expect(typeof payload.durationMs).toBe('number');
                expect(payload.failureStage).toBeNull();
                expect(payload.provenance.sourceType).toBe('ai');
                expect(payload.dataQuality.status).toBe('degraded');
            }
        );
    });

    it('degrades agent analysis to a fallback payload when model JSON is invalid', async () => {
        process.env.GEMINI_API_KEY = 'test-key';
        vi.doMock('@google/genai', () => ({
            Type: {
                OBJECT: 'object',
                STRING: 'string',
                INTEGER: 'integer',
                ARRAY: 'array',
            },
            GoogleGenAI: class {
                models = {
                    generateContent: vi.fn().mockResolvedValue({ text: 'not-json' }),
                };
            },
        }));

        await withServer(
            { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const { headers } = await registerAuthHeaders(baseUrl, 'agent-fallback@example.com');
                const response = await fetch(`${baseUrl}/api/ai/agent-analysis`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ headline: 'AMD expands data center roadmap', agentId: 'agent-bear', alphaScore: 65 }),
                });
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(payload.mode).toBe('fallback');
                expect(payload.reason).toBe('backend_error');
                expect(payload.failureStage).toBe('model');
                expect(payload.notice).toContain('invalid JSON');
                expect(payload.position).toBe('SHORT');
            }
        );
    });

    it('returns bounded price history for requested symbols', async () => {
        const getPriceHistory = vi.fn().mockReturnValue({
            AAPL: [
                { symbol: 'AAPL', price: 103, timestamp: 1, source: 'YahooFinance' },
                { symbol: 'AAPL', price: 105, timestamp: 2, source: 'YahooFinance' },
            ],
        });
        vi.doMock('../../server/services/priceService', () => ({
            getMarketPrices: vi.fn().mockResolvedValue([]),
            getHistoricalPriceResult: vi.fn().mockResolvedValue({
                history: {
                    AAPL: [
                        { symbol: 'AAPL', price: 103, timestamp: 1, source: 'YahooFinance' },
                        { symbol: 'AAPL', price: 105, timestamp: 2, source: 'YahooFinance' },
                    ],
                },
                errors: {},
                dataQuality: { status: 'ready', observations: 2, missingSymbols: [], source: 'InMemoryFallback' },
            }),
            getPriceHistory,
            isPriceHistoryRange: (value: unknown) => value === '3M' || value === '6M' || value === '12M' || value === '24M',
        }));

        await withServer(
            { status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/api/news/prices/history?symbols=AAPL&limit=2`);
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(payload.success).toBe(true);
                expect(payload.symbols).toEqual(['AAPL']);
                expect(payload.history.AAPL).toHaveLength(2);
                expect(payload.history.AAPL[1].price).toBe(105);
                // The route must forward the parsed `limit` query to the history store (the bound itself is
                // enforced and tested in priceService.test.ts).
                expect(getPriceHistory).toHaveBeenCalledWith(['AAPL'], 2);
            }
        );
    });

    it('bypasses the RSS feed cache when refresh=1 is requested', async () => {
        const aggregateAllSources = vi.fn().mockResolvedValue([
            {
                id: 'rss-1',
                headline: 'Fresh force refresh headline',
                timestamp: 1,
                category: 'STOCKS',
                source: 'Wire',
                sourceReliability: 95,
                urgency: 'LOW',
                relatedTickers: ['AAPL'],
                isAnalyzed: false,
                isAnalysing: false,
            },
        ]);
        const forceRefresh = vi.fn();

        await withBackendTestServer(
            async (baseUrl) => {
                const response = await fetch(`${baseUrl}/api/news/feed?limit=3&refresh=1`);
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(forceRefresh).toHaveBeenCalledTimes(1);
                expect(aggregateAllSources).toHaveBeenCalledTimes(1);
                expect(payload.items[0].headline).toBe('Fresh force refresh headline');
            },
            {
                beforeImport: () => {
                    vi.doMock('../../server/services/quantClient', () => ({
                        checkQuantHealth: vi.fn().mockResolvedValue({ status: 'reachable', reason: null, checkedAt: '2026-04-18T12:00:00.000Z' }),
                        requestQuantForecast: vi.fn().mockResolvedValue({ ok: false, data: null }),
                    }));
                    vi.doMock('../../server/services/rssAggregator', () => ({
                        aggregateAllSources,
                        forceRefresh,
                        getFilteredByCategory: vi.fn((items, category) => items.filter((item: { category: string }) => item.category === category)),
                        getCachedNewsSnapshot: vi.fn().mockReturnValue([]),
                    }));
                },
                restoreDatabaseUrlBeforeHandler: true,
                seedComplianceDatasetPath: defaultDatasetPath,
            }
        );
    });

    it('returns quant fallback with model governance metadata', async () => {
        await withServer(
            { status: 'unreachable', reason: 'connection_refused', checkedAt: '2026-04-18T12:00:00.000Z' },
            async (baseUrl) => {
                const { headers } = await registerAuthHeaders(baseUrl, 'quant@example.com');
                const response = await fetch(`${baseUrl}/api/quant/short-term`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ ticker: 'AAPL', current_price: 100 }),
                });
                const payload = await response.json();

                expect(response.status).toBe(200);
                expect(payload.success).toBe(true);
                expect(payload.isFallback).toBe(true);
                expect(payload.modelGovernance.horizon).toBe('short-term');
                expect(payload.modelGovernance.validationStatus).toBe('heuristic_baseline');
                expect(payload.provenance.sourceType).toBe('quant');
                expect(payload.dataQuality.status).toBe('degraded');
            }
        );
    });
});
