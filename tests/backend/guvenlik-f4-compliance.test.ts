import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withBackendTestServer } from './testServer';

// F-4 (HIGH, business logic / ASVS 11.1.4): `complianceMiddleware` only looked at `headline` and the
// `tickers`/`affectedAssets` fields. `/api/ai/chat` (body: `messages`),
// `/api/ai/agent-analysis` (single `ticker`) and `/api/quant/*` (single `ticker`) skipped the restricted-security
// check; when `tickers` arrived as a string/object the middleware threw a TypeError and wrongly returned 503.
// Source: docs/test-temel/ajan5-guvenlik.md (F-4), RAPOR.md section 5.
// Restricted list (server/data/compliance-snapshot.json): XYZ, RIVAL, GOV1.

const TEST_SECRET = 'f4-compliance-test-secret-not-a-real-key';
const datasetPath = path.join(process.cwd(), 'server/data/compliance-snapshot.json');

async function withTestServer(handler: (baseUrl: string, headers: Record<string, string>) => Promise<void>) {
    await withBackendTestServer(async (baseUrl) => {
        const credentials = JSON.stringify({ email: 'f4-compliance@example.com', password: 'password123' });
        const jsonHeaders = { 'Content-Type': 'application/json' };
        const registered = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST', headers: jsonHeaders, body: credentials });
        expect(registered.status).toBe(202);
        const loggedIn = await fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: jsonHeaders, body: credentials });
        expect(loggedIn.status).toBe(200);
        const payload = await loggedIn.json();
        await handler(baseUrl, { 'Content-Type': 'application/json', Authorization: `Bearer ${payload.token}` });
    }, {
        jwtSecret: TEST_SECRET,
        seedComplianceDatasetPath: datasetPath,
        beforeImport: () => {
            vi.doMock('../../server/services/quantClient', () => ({
                checkQuantHealth: vi.fn().mockResolvedValue({ status: 'unreachable', reason: 'connection_refused', checkedAt: '2026-04-18T12:00:00.000Z' }),
                requestQuantForecast: vi.fn().mockResolvedValue({ ok: false, data: null, reason: 'connection_refused' }),
            }));
        },
    });
}

async function send(baseUrl: string, headers: Record<string, string>, route: string, body: unknown) {
    const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const payload = await response.json();
    return { status: response.status, payload };
}

describe('F-4: the compliance check also covers the chat, agent-analysis and quant routes', () => {
    beforeEach(() => {
        process.env.NODE_ENV = 'test';
        process.env.GEMINI_API_KEY = '';
        for (const method of ['log', 'warn', 'error'] as const) {
            vi.spyOn(console, method).mockImplementation(() => undefined);
        }
    });

    afterEach(() => {
        delete process.env.NODE_ENV;
        delete process.env.GEMINI_API_KEY;
    });

    describe('/api/ai/chat', () => {
        it.each([
            ['content field', { role: 'user', content: 'Is XYZ a good buy right now?' }],
            ['text field', { role: 'user', text: 'Is XYZ a good buy right now?' }],
            ['lowercase and punctuation', { role: 'user', content: 'thoughts on (xyz)?' }],
        ])('restricted security in the message text (%s) -> 403 COMPLIANCE_BLOCK', async (_label, message) => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, '/api/ai/chat', { messages: [message] });
                expect(status).toBe(403);
                expect(payload.error).toBe('COMPLIANCE_BLOCK');
                expect(payload.matches).toEqual(expect.arrayContaining([expect.objectContaining({ ticker: 'XYZ' })]));
                expect(payload.text).toBeUndefined();
            });
        });

        it('is also blocked when the restricted security appears in one of the earlier messages', async () => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, '/api/ai/chat', {
                    messages: [
                        { role: 'user', content: 'Tell me about RIVAL earnings' },
                        { role: 'model', content: 'Sure.' },
                        { role: 'user', content: 'And what about the broader market?' },
                    ],
                });
                expect(status).toBe(403);
                expect(payload.error).toBe('COMPLIANCE_BLOCK');
            });
        });

        it('a normal chat request without restricted securities is unaffected', async () => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, '/api/ai/chat', {
                    messages: [{ role: 'user', content: 'Give me a view on AAPL and the Fed outlook' }],
                });
                expect(status).toBe(200);
                expect(payload.success).toBe(true);
            });
        });
    });

    describe('/api/ai/agent-analysis', () => {
        it('restricted security in the single `ticker` field -> 403 COMPLIANCE_BLOCK', async () => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, '/api/ai/agent-analysis', {
                    headline: 'Chipmakers rally on strong demand',
                    agentId: 'agent-bear',
                    ticker: 'xyz',
                });
                expect(status).toBe(403);
                expect(payload.error).toBe('COMPLIANCE_BLOCK');
                expect(payload.matches).toEqual(expect.arrayContaining([expect.objectContaining({ ticker: 'XYZ', matchedBy: 'ticker' })]));
            });
        });

        it('a request with a non-restricted `ticker` passes', async () => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, '/api/ai/agent-analysis', {
                    headline: 'Chipmakers rally on strong demand',
                    agentId: 'agent-bear',
                    ticker: 'AAPL',
                });
                expect(status).toBe(200);
                expect(payload.error).toBeUndefined();
            });
        });
    });

    describe('/api/quant/:horizon', () => {
        it.each(['short-term', 'medium-term', 'long-term'])('restricted security `ticker` (%s) -> 403 COMPLIANCE_BLOCK', async (horizon) => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, `/api/quant/${horizon}`, { ticker: 'XYZ', current_price: 10 });
                expect(status).toBe(403);
                expect(payload.error).toBe('COMPLIANCE_BLOCK');
                expect(payload.isFallback).toBeUndefined();
            });
        });

        it('a lowercase, whitespace-padded restricted ticker is also blocked', async () => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, '/api/quant/short-term', { ticker: '  rival ', current_price: 10 });
                expect(status).toBe(403);
                expect(payload.error).toBe('COMPLIANCE_BLOCK');
            });
        });

        it('a quant request without restricted securities is unaffected', async () => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, '/api/quant/short-term', { ticker: 'AAPL', current_price: 100 });
                expect(status).toBe(200);
                expect(payload.success).toBe(true);
            });
        });
    });

    describe('unexpected `tickers` types return 400/403, not 503', () => {
        it.each([
            ['string', 'XYZ'],
            ['object', { symbol: 'XYZ' }],
            ['number', 42],
            ['non-string element', [1, 2]],
            ['nested array', [['XYZ']]],
        ])('/api/ai/analyze tickers=%s', async (_label, tickers) => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, '/api/ai/analyze', { headline: 'Chipmakers rally', tickers });
                expect(status).not.toBe(503);
                expect([400, 403]).toContain(status);
                expect(payload.error).not.toBe('COMPLIANCE_DATA_UNAVAILABLE');
            });
        });

        it('/api/ai/deep-dive with affectedAssets as a string returns 400/403, not 503', async () => {
            await withTestServer(async (baseUrl, headers) => {
                const { status } = await send(baseUrl, headers, '/api/ai/deep-dive', { headline: 'Chipmakers rally', affectedAssets: 'XYZ' });
                expect([400, 403]).toContain(status);
            });
        });

        it('a restricted ticker inside a valid `tickers` array still returns 403', async () => {
            await withTestServer(async (baseUrl, headers) => {
                const { status, payload } = await send(baseUrl, headers, '/api/ai/analyze', { headline: 'Chipmakers rally', tickers: ['aapl', 'xyz'] });
                expect(status).toBe(403);
                expect(payload.error).toBe('COMPLIANCE_BLOCK');
            });
        });
    });
});
