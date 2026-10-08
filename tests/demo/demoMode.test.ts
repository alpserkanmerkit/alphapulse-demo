import http from 'node:http';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBackendTestServer } from '../backend/testServer';
import { enterDemoMode, resolveDemoMode } from '../../server/demo/demoMode';
import { buildDemoEnv } from '../../scripts/demoEnv';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../../shared/demoAccount';

// Demo mode behaviour: with DEMO_MODE=1 the server answers with sample data without calling external services
// (RSS, CoinGecko, Yahoo/quant bridge, Gemini, Redis).

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Records http/https calls (any external host other than loopback = violation). It also lets the real call through,
// so a violation turns the test red via the record instead of passing silently.
function trackOutboundHosts() {
    const hosts: string[] = [];
    const record = (args: unknown[]) => {
        const first = args[0];
        let host = '';
        if (typeof first === 'string') host = new URL(first).hostname;
        else if (first instanceof URL) host = first.hostname;
        else if (first && typeof first === 'object') {
            const opts = first as { hostname?: string; host?: string };
            host = opts.hostname ?? opts.host ?? '';
        }
        if (host && !LOOPBACK.has(host)) hosts.push(host);
    };
    for (const mod of [http, https] as const) {
        for (const method of ['request', 'get'] as const) {
            const original = mod[method] as (...a: unknown[]) => unknown;
            vi.spyOn(mod, method as 'request').mockImplementation(((...args: unknown[]) => {
                record(args);
                return original.apply(mod, args);
            }) as never);
        }
    }
    return hosts;
}

describe('resolveDemoMode', () => {
    it('DEMO_MODE=1 / true explicitly enables demo', () => {
        expect(resolveDemoMode({ DEMO_MODE: '1', GEMINI_API_KEY: 'k' })).toEqual({ demo: true, auto: false });
        expect(resolveDemoMode({ DEMO_MODE: 'true' })).toEqual({ demo: true, auto: false });
    });

    it('DEMO_MODE=0 disables demo even without a key', () => {
        expect(resolveDemoMode({ DEMO_MODE: '0', NODE_ENV: 'development' })).toEqual({ demo: false, auto: false });
    });

    it('no DEMO_MODE + no GEMINI_API_KEY => automatic demo', () => {
        expect(resolveDemoMode({ NODE_ENV: 'development' })).toEqual({ demo: true, auto: true });
        expect(resolveDemoMode({})).toEqual({ demo: true, auto: true });
    });

    it('no automatic demo when a key is present', () => {
        expect(resolveDemoMode({ GEMINI_API_KEY: 'key' })).toEqual({ demo: false, auto: false });
    });

    it('in production a missing key never silently falls back to fake data', () => {
        expect(resolveDemoMode({ NODE_ENV: 'production' })).toEqual({ demo: false, auto: false });
    });
});

describe('enterDemoMode', () => {
    it('disables external service keys and the Redis/PDF queue', () => {
        const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: 'x', REDIS_URL: 'redis://h:6379', PDF_EXPORT_ENABLED: 'true' };
        enterDemoMode(env);
        expect(env.DEMO_MODE).toBe('1');
        expect(env.GEMINI_API_KEY).toBeUndefined();
        expect(env.REDIS_URL).toBeUndefined();
        expect(env.PDF_EXPORT_ENABLED).toBe('false');
    });
});

describe('buildDemoEnv (npm run demo)', () => {
    const opts = { apiPort: 3101, uiPort: 3100, databaseUrl: 'file:/tmp/demo.db' };

    it('generates a new random JWT_SECRET of >=32 bytes on every call; never inherits a secret from the environment', () => {
        const base = { JWT_SECRET: 'short', GEMINI_API_KEY: 'x', REDIS_URL: 'redis://h' } as NodeJS.ProcessEnv;
        const a = buildDemoEnv(base, opts);
        const b = buildDemoEnv(base, opts);
        expect(Buffer.byteLength(a.JWT_SECRET ?? '', 'utf8')).toBeGreaterThanOrEqual(32);
        expect(a.JWT_SECRET).not.toBe(b.JWT_SECRET);
        expect(a.JWT_SECRET).not.toBe('short');
        expect(a.GEMINI_API_KEY).toBeUndefined();
        expect(a.REDIS_URL).toBeUndefined();
        expect(base.JWT_SECRET).toBe('short');
    });

    it('sets the demo flags, ports and the temporary database', () => {
        const env = buildDemoEnv({}, opts);
        expect(env.DEMO_MODE).toBe('1');
        expect(env.VITE_DEMO_MODE).toBe('1');
        expect(env.SERVER_PORT).toBe('3101');
        expect(env.VITE_API_BASE_URL).toBe('http://127.0.0.1:3101');
        expect(env.CORS_ORIGINS).toContain('http://127.0.0.1:3100');
        expect(env.DATABASE_URL).toBe('file:/tmp/demo.db');
        expect(env.NODE_ENV).not.toBe('production');
    });
});

describe('demo mode: the data layer never reaches the external network', () => {
    beforeEach(() => {
        process.env.DEMO_MODE = '1';
    });
    afterEach(() => {
        delete process.env.DEMO_MODE;
    });

    it('news, prices and history come from sample data', async () => {
        const hosts = trackOutboundHosts();
        const { aggregateAllSources } = await import('../../server/services/rssAggregator');
        const { getMarketPrices, getHistoricalPriceResult, getPriceBySymbol } = await import('../../server/services/priceService');

        const news = await aggregateAllSources();
        expect(news.length).toBeGreaterThanOrEqual(8);
        for (const item of news) {
            expect(item.headline).toEqual(expect.any(String));
            expect(item.timestamp).toEqual(expect.any(Number));
            expect(item.source).toEqual(expect.any(String));
        }

        const prices = await getMarketPrices();
        expect(prices.length).toBeGreaterThanOrEqual(15);
        expect(prices.every((tick) => tick.price > 0 && tick.source === 'DemoData')).toBe(true);
        const aapl = await getMarketPrices(['aapl']);
        expect(aapl.map((tick) => tick.symbol)).toEqual(['AAPL']);
        expect(getPriceBySymbol('AAPL')?.price).toBeGreaterThan(0);

        const history = await getHistoricalPriceResult(['AAPL', 'BTC'], '3M');
        expect(history.dataQuality.status).toBe('ready');
        expect(history.history.AAPL.length).toBeGreaterThanOrEqual(60);
        expect(history.history.BTC.length).toBeGreaterThanOrEqual(60);
        // The quote must match the last close (the UI does not merge an inconsistent quote with history).
        const last = history.history.AAPL[history.history.AAPL.length - 1];
        expect(Math.abs(last.price - aapl[0].price) / aapl[0].price).toBeLessThan(0.05);

        expect(hosts).toEqual([]);
    });

    it('data is deterministic for the same symbol (stable tests and screenshots)', async () => {
        const { getHistoricalPriceResult } = await import('../../server/services/priceService');
        const first = await getHistoricalPriceResult(['NVDA'], '6M');
        const second = await getHistoricalPriceResult(['NVDA'], '6M');
        expect(second.history.NVDA.map((p) => p.price)).toEqual(first.history.NVDA.map((p) => p.price));
    });
});

describe('demo mode: HTTP endpoints', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const json = { 'Content-Type': 'application/json' };

    async function demoLogin(baseUrl: string) {
        const login = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
        });
        return { login, body: await login.json() };
    }

    it('starts without keys/Redis; news, prices, history, demo account, portfolio and risk return 200', async () => {
        const hosts = trackOutboundHosts();
        await withBackendTestServer(async (baseUrl) => {
            const get = (path: string, token?: string) =>
                fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

            const health = await get('/health');
            expect(health.status).toBe(200);
            expect((await health.json()).demo).toBe(true);

            const feed = await get('/api/news/feed?limit=5');
            expect(feed.status).toBe(200);
            const feedBody = await feed.json();
            expect(feedBody.items).toHaveLength(5);
            expect(feedBody.provenance.mode).toBe('simulation');

            const prices = await get('/api/news/prices?symbols=AAPL,BTC');
            expect(prices.status).toBe(200);
            const pricesBody = await prices.json();
            expect(pricesBody.prices).toHaveLength(2);
            expect(pricesBody.provenance.mode).toBe('simulation');

            const history = await get('/api/news/prices/history?symbols=AAPL&range=3M');
            expect(history.status).toBe(200);
            expect((await history.json()).history.AAPL.length).toBeGreaterThanOrEqual(60);

            const { login, body } = await demoLogin(baseUrl);
            expect(login.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.token).toEqual(expect.any(String));
            expect(body.user.email).toBe(DEMO_EMAIL);
            expect(body.user.teamContext.teamId).toEqual(expect.any(String));

            const portfolio = await get('/api/portfolio/state', body.token);
            expect(portfolio.status).toBe(200);
            expect((await portfolio.json()).portfolio.positions.length).toBeGreaterThanOrEqual(3);

            // A second login does not re-seed the same portfolio.
            const again = (await demoLogin(baseUrl)).body;
            const portfolioAgain = await (await get('/api/portfolio/state', again.token)).json();
            expect(portfolioAgain.portfolio.positions.length).toBeLessThanOrEqual(10);

            const risk = await get('/api/portfolio/risk', body.token);
            expect(risk.status).toBe(200);
            expect((await risk.json()).risk.metrics).not.toBeNull();

            expect((await get('/api/compliance/summary', body.token)).status).toBe(200);

            // A wrong password is rejected for the demo account too; the password is not stored in plain text.
            const wrong = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: DEMO_EMAIL, password: `${DEMO_PASSWORD}-wrong` }) });
            expect(wrong.status).toBe(401);
            const { prisma } = await import('../../server/shared/db/db');
            const stored = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
            expect(stored?.password).not.toBe(DEMO_PASSWORD);
            expect(stored?.password.startsWith('$2')).toBe(true);
        }, { env: { DEMO_MODE: '1', GEMINI_API_KEY: undefined, REDIS_URL: undefined } });

        expect(hosts).toEqual([]);
    }, 60_000);

    it('AI endpoints reply with fixed sample text (no Gemini, no delay, deterministic)', async () => {
        const hosts = trackOutboundHosts();
        await withBackendTestServer(async (baseUrl) => {
            const { body } = await demoLogin(baseUrl);
            const post = async (path: string, payload: unknown) => {
                const response = await fetch(`${baseUrl}${path}`, {
                    method: 'POST',
                    headers: { ...json, Authorization: `Bearer ${body.token}` },
                    body: JSON.stringify(payload),
                });
                return { status: response.status, data: await response.json() };
            };
            const headline = 'Nvidia extends AI infrastructure rally as data-center demand beats estimates';
            const forbidden = /GEMINI_API_KEY|mock contract|Mock rationale|Math\.random/i;

            const startedAt = Date.now();
            const first = await post('/api/ai/analyze', { headline, category: 'STOCKS', source: 'Demo Markets Wire' });
            const second = await post('/api/ai/analyze', { headline, category: 'STOCKS', source: 'Demo Markets Wire' });
            expect(first.status).toBe(200);
            expect(first.data.mode).toBe('simulation');
            expect(first.data.score).toBeGreaterThanOrEqual(0);
            expect(first.data.score).toBeLessThanOrEqual(100);
            expect(first.data.sentiment).toBe('POSITIVE');
            expect(first.data.affectedAssets).toContain('NVDA');
            expect(first.data.notice).toMatch(/demo/i);
            expect(JSON.stringify(first.data)).not.toMatch(forbidden);
            expect({ score: second.data.score, summary: second.data.summary }).toEqual({ score: first.data.score, summary: first.data.summary });
            expect(Date.now() - startedAt).toBeLessThan(700);

            const deep = await post('/api/ai/deep-dive', { headline, category: 'STOCKS', tickers: ['NVDA'], alphaScore: 80 });
            expect(deep.status).toBe(200);
            expect(deep.data.mode).toBe('simulation');
            expect(JSON.stringify(deep.data)).not.toMatch(forbidden);
            expect(JSON.stringify(deep.data)).toContain(headline);

            const agent = await post('/api/ai/agent-analysis', { headline, agentId: 'agent-bull', alphaScore: 80 });
            expect(agent.status).toBe(200);
            expect(JSON.stringify(agent.data)).not.toMatch(forbidden);

            const debate = await post('/api/ai/debate', { headline, alphaScore: 80 });
            expect(debate.status).toBe(200);
            expect(JSON.stringify(debate.data)).not.toMatch(forbidden);

            const chat = await post('/api/ai/chat', { messages: [{ id: '1', role: 'user', text: 'Should I buy NVDA? risk medium' }] });
            expect(chat.status).toBe(200);
            expect(chat.data.text).toMatch(/demo/i);
            expect(chat.data.text).not.toMatch(forbidden);
        }, { env: { DEMO_MODE: '1', GEMINI_API_KEY: undefined, REDIS_URL: undefined } });

        expect(hosts).toEqual([]);
    }, 60_000);

    it('with demo mode off there is no demo account and no legacy /api/demo/login', async () => {
        await withBackendTestServer(async (baseUrl) => {
            const { login } = await demoLogin(baseUrl);
            expect(login.status).toBe(401);
            expect((await fetch(`${baseUrl}/api/demo/login`, { method: 'POST' })).status).toBe(404);
            const { prisma } = await import('../../server/shared/db/db');
            expect(await prisma.user.count({ where: { email: DEMO_EMAIL } })).toBe(0);
            const health = await (await fetch(`${baseUrl}/health`)).json();
            expect(health.demo).toBe(false);
        }, { env: { DEMO_MODE: undefined } });
    }, 60_000);
});
