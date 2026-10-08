import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect, test } from '@playwright/test';
import { DEMO_EMAIL, DEMO_PASSWORD } from '../shared/demoAccount';

const API = 'http://127.0.0.1:3001';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

test.describe('@demo smoke test', () => {
    test('API: health and sample-data endpoints return 200', async ({ request }) => {
        const health = await request.get(`${API}/health`);
        expect(health.status()).toBe(200);
        const healthBody = await health.json();
        expect(healthBody.status).toBe('ok');
        expect(healthBody.demo).toBe(true);

        const feed = await request.get(`${API}/api/news/feed?limit=5`);
        expect(feed.status()).toBe(200);
        const feedBody = await feed.json();
        expect(feedBody.items.length).toBe(5);
        expect(feedBody.provenance.mode).toBe('simulation');

        const prices = await request.get(`${API}/api/news/prices?symbols=AAPL,BTC,NVDA`);
        expect(prices.status()).toBe(200);
        expect((await prices.json()).prices).toHaveLength(3);

        const history = await request.get(`${API}/api/news/prices/history?symbols=AAPL&range=3M`);
        expect(history.status()).toBe(200);
        expect((await history.json()).history.AAPL.length).toBeGreaterThanOrEqual(60);

        const login = await request.post(`${API}/api/auth/login`, { data: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
        expect(login.status()).toBe(200);
        const { token } = await login.json();
        const portfolio = await request.get(`${API}/api/portfolio/state`, { headers: { Authorization: `Bearer ${token}` } });
        expect(portfolio.status()).toBe(200);
        expect((await portfolio.json()).portfolio.positions.length).toBeGreaterThan(0);

        const analysis = await request.post(`${API}/api/ai/analyze`, {
            headers: { Authorization: `Bearer ${token}` },
            data: { headline: 'Bitcoin holds above key level after spot ETF inflows return', category: 'CRYPTO', source: 'Demo' },
        });
        expect(analysis.status()).toBe(200);
        expect((await analysis.json()).mode).toBe('simulation');
    });

    test('UI: root returns 200, demo auto-login, main screens render without errors', async ({ page, request }, testInfo) => {
        const root = await request.get('/');
        expect(root.status()).toBe(200);

        const pageErrors: string[] = [];
        const consoleErrors: string[] = [];
        const externalRequests: string[] = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        // The demo never reaches the external network: every non-local request is recorded and aborted (e.g. Google Fonts).
        await page.route('**/*', async (route) => {
            const { hostname, protocol } = new URL(route.request().url());
            if (protocol === 'data:' || protocol === 'blob:' || LOCAL_HOSTS.has(hostname)) {
                await route.continue();
                return;
            }
            externalRequests.push(hostname);
            await route.abort();
        });

        await page.goto('/');
        // No login form: the demo session opens on its own and redirects to /dashboard.
        await expect(page.getByRole('heading', { name: 'Live Intelligence Feed' })).toBeVisible();
        await expect(page.getByText('Nvidia extends AI infrastructure rally')).toBeVisible();

        const screenshotPath = testInfo.outputPath('demo-ap-ekran.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        if (process.env.DEMO_SCREENSHOT) {
            mkdirSync(dirname(process.env.DEMO_SCREENSHOT), { recursive: true });
            copyFileSync(screenshotPath, process.env.DEMO_SCREENSHOT);
        }

        await page.getByRole('link', { name: 'Portfolio & Risk' }).click();
        await expect(page.getByRole('heading', { name: 'Live Portfolio' })).toBeVisible();
        await expect(page.getByText('5 positions')).toBeVisible();

        await page.getByRole('link', { name: 'Strategy Boardroom' }).click();
        await expect(page.getByRole('heading', { name: 'Strategy Boardroom' })).toBeVisible();

        await page.getByRole('link', { name: 'Compliance' }).click();
        await expect(page.getByRole('heading', { name: 'Compliance Centre' })).toBeVisible();

        expect(pageErrors).toEqual([]);
        // Only console lines caused by the aborted external resources ("Failed to load resource") are expected.
        expect(consoleErrors.filter((text) => !/Failed to load resource/i.test(text))).toEqual([]);
        console.log(`[demo-smoke] external requests (aborted): ${[...new Set(externalRequests)].join(', ') || 'none'}`);
    });
});
