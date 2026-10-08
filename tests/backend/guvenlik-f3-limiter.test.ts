import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBackendTestServer } from './testServer';

// F-3 (HIGH, availability): under `app.use('/api/', apiLimiter)`, `req.path` arrives stripped of the mount
// prefix (`/news/feed`), but the `skip` function compared it with `/api/news/...`; it never matched,
// so market-data GETs consumed the general 300/15min quota and `marketReadLimiter` (1500) had no
// effect. These tests encode that market reads are counted separately from the general quota.
// Source: docs/test-temel/ajan5-guvenlik.md (F-3), RAPOR.md section 5.

const TEST_SECRET = 'f3-limiter-test-secret-not-a-real-key';
const API_BUDGET = 300;
const MARKET_BUDGET = 1500;

async function withTestServer(handler: (baseUrl: string) => Promise<void>) {
    await withBackendTestServer(handler, {
        jwtSecret: TEST_SECRET,
        seedCompliance: false,
        beforeImport: () => {
            // Market endpoints return empty/deterministic responses instead of hitting the network; only rate limiting is tested.
            vi.doMock('../../server/services/rssAggregator', async (importOriginal) => ({
                ...(await importOriginal<typeof import('../../server/services/rssAggregator')>()),
                aggregateAllSources: vi.fn().mockResolvedValue([]),
                startAutoRefresh: vi.fn(),
            }));
            vi.doMock('../../server/services/priceService', async (importOriginal) => ({
                ...(await importOriginal<typeof import('../../server/services/priceService')>()),
                getMarketPrices: vi.fn().mockResolvedValue([]),
            }));
        },
    });
}

function login(baseUrl: string) {
    return fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'password123' }),
    });
}

async function flood(url: string, count: number, init?: RequestInit): Promise<Response[]> {
    const responses: Response[] = [];
    for (let attempt = 0; attempt < count; attempt += 1) {
        const response = await fetch(url, init);
        await response.arrayBuffer();
        responses.push(response);
    }
    return responses;
}

describe('F-3: market-data GET requests do not consume the general API quota', () => {
    beforeEach(() => {
        process.env.NODE_ENV = 'test';
        for (const method of ['log', 'warn', 'error'] as const) {
            vi.spyOn(console, method).mockImplementation(() => undefined);
        }
    });

    afterEach(() => {
        delete process.env.NODE_ENV;
    });

    it.each([
        ['/api/news/feed?limit=1'],
        ['/api/news/feed/CRYPTO'],
        ['/api/news/prices?symbols=AAPL'],
        ['/api/news/prices/history?symbols=AAPL&limit=2'],
    ])('GET %s does not decrement the general 300 quota; the separate market limit (1500) applies', async (path) => {
        await withTestServer(async (baseUrl) => {
            const first = await fetch(`${baseUrl}${path}`);
            await first.arrayBuffer();

            const responses = await flood(`${baseUrl}${path}`, API_BUDGET + 10);
            expect(responses.filter((response) => response.status === 429)).toHaveLength(0);

            // After market GETs exceed 300, another route fed by the general quota is still open.
            const afterFlood = await login(baseUrl);
            await afterFlood.arrayBuffer();
            expect(afterFlood.status).not.toBe(429);
            // The quota seen in the response must be the market limiter's (1500), not the general one (300).
            expect(first.headers.get('ratelimit-limit')).toBe(String(MARKET_BUDGET));
            // The general quota was not affected by market requests: only this login was counted.
            expect(afterFlood.headers.get('ratelimit-limit')).toBe(String(API_BUDGET));
            expect(Number(afterFlood.headers.get('ratelimit-remaining'))).toBeGreaterThanOrEqual(API_BUDGET - 5);
        });
    });

    it('RateLimit-Remaining on market GET responses decrements the market quota, not the general one', async () => {
        await withTestServer(async (baseUrl) => {
            const first = await fetch(`${baseUrl}/api/news/prices?symbols=AAPL`);
            const second = await fetch(`${baseUrl}/api/news/prices?symbols=AAPL`);
            await first.arrayBuffer();
            await second.arrayBuffer();

            const firstRemaining = Number(first.headers.get('ratelimit-remaining'));
            const secondRemaining = Number(second.headers.get('ratelimit-remaining'));
            expect(firstRemaining).toBeGreaterThan(API_BUDGET);
            expect(secondRemaining).toBe(firstRemaining - 1);
        });
    });

    it('the general limit still applies to non-market routes: the 301st GET /api/news/other gets 429', async () => {
        await withTestServer(async (baseUrl) => {
            const responses = await flood(`${baseUrl}/api/news/not-a-market-path`, API_BUDGET + 1);
            const throttled = responses.filter((response) => response.status === 429);
            expect(throttled.length).toBeGreaterThan(0);
            expect(responses.length - throttled.length).toBeLessThanOrEqual(API_BUDGET);
        });
    });

    it('non-GET methods on market routes count against the general quota (skip is GET-only)', async () => {
        await withTestServer(async (baseUrl) => {
            const responses = await flood(`${baseUrl}/api/news/prices`, API_BUDGET + 1, { method: 'POST' });
            const throttled = responses.filter((response) => response.status === 429);
            expect(throttled.length).toBeGreaterThan(0);
        });
    });
});
