import { expect, test, type Route } from '@playwright/test';

const complianceSummary = {
    version: 1,
    hash: '1b9451ec86ff7693',
    updatedAt: '2026-04-18T12:00:00.000Z',
    alerts: [],
    restricted: [],
    audit: [],
};

const newsItems = [
    { id: 'n1', headline: 'Nvidia extends AI infrastructure rally', timestamp: 1, category: 'STOCKS', source: 'Wire' },
    { id: 'n2', headline: 'Oil supply risks pressure logistics names', timestamp: 2, category: 'MACRO', source: 'Wire' },
    { id: 'n3', headline: 'Bitcoin demand rises after ETF flows', timestamp: 3, category: 'CRYPTO', source: 'Wire' },
];

const refreshedNewsItems = [
    { id: 'n4', headline: 'Manual refresh delivers new market intelligence', timestamp: 4, category: 'STOCKS', source: 'Wire' },
    ...newsItems.slice(0, 2),
];

async function mockBaseApp(page: import('@playwright/test').Page, options?: {
    runtime?: Record<string, unknown>;
    analyzeMode?: 'live' | 'simulation';
    analyzeNotice?: string;
    teamRole?: 'ADMIN' | 'COMPLIANCE_OFFICER' | 'FUND_MANAGER' | 'ANALYST';
    priceMode?: 'live' | 'stale' | 'unavailable';
}) {
    const activeTeam = {
        teamId: 'team-1',
        teamName: 'AlphaPulse Compliance',
        role: options?.teamRole ?? 'ANALYST',
    };
    let teamMembers = [
        { id: 'tm-1', userId: 'user-1', email: 'test@example.com', name: 'Test User', role: activeTeam.role, createdAt: new Date().toISOString() },
        { id: 'tm-2', userId: 'user-2', email: 'member@example.com', name: 'Member User', role: 'ANALYST', createdAt: new Date().toISOString() },
    ];

    await page.addInitScript((team) => {
        window.sessionStorage.setItem('alphapulse-auth', JSON.stringify({
            state: {
                token: 'test-token',
                user: { id: 'user-1', email: 'test@example.com', name: 'Test User', role: team.role, teamContext: team },
                isAuthenticated: true,
            },
            version: 0,
        }));
    }, activeTeam);

    const runtime = {
        status: 'ok',
        version: '2.0.0',
        mode: 'live',
        services: {
            ai: options?.analyzeMode ?? 'live',
            quant: 'unreachable',
            compliance: 'ready',
        },
        diagnostics: {
            quant: {
                reason: 'connection_refused',
                checkedAt: '2026-04-18T12:00:00.000Z',
            },
            compliance: {
                source: 'local-file',
                reason: null,
                loadedAt: '2026-04-18T12:00:00.000Z',
            },
        },
        timestamp: '2026-04-18T12:00:00.000Z',
        ...options?.runtime,
    };
    const portfolioState = {
        id: 'portfolio-1',
        userId: 'user-1',
        totalBalance: 100000,
        cashBalance: 90000,
        currentVaR: 0,
        updatedAt: new Date().toISOString(),
        positions: [
            { id: 'pos-1', ticker: 'AAPL', quantity: 100, averagePrice: 100, currentPrice: 100, updatedAt: new Date().toISOString() },
        ],
        transactions: [] as Array<{ id: string; ticker: string; type: string; quantity: number; price: number; commission: number; timestamp: string }>,
    };

    await page.route('**/health', async (route) => {
        await route.fulfill({ json: runtime });
    });

    await page.route('**/api/news/feed?*', async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('refresh') === '1') {
            await new Promise((resolve) => setTimeout(resolve, 150));
            await route.fulfill({ json: { items: refreshedNewsItems } });
            return;
        }
        await route.fulfill({ json: { items: newsItems } });
    });

    await page.route('**/api/news/prices/history?*', async (route) => {
        const now = Date.now();
        await route.fulfill({
            json: {
                success: true,
                symbols: ['AAPL'],
                history: {
                    AAPL: [
                        { symbol: 'AAPL', price: 103, open: 101, high: 104, low: 100, close: 103, volume: 1_000_000, timestamp: now - 86_400_000, source: 'YahooFinance', interval: '1d' },
                        { symbol: 'AAPL', price: 105, open: 103, high: 106, low: 102, close: 105, volume: 1_150_000, timestamp: now, source: 'YahooFinance', interval: '1d' },
                    ],
                },
            },
        });
    });

    const fulfillPrices = async (route: Route) => {
        if (options?.priceMode === 'unavailable') {
            await route.fulfill({
                json: {
                    success: true,
                    count: 0,
                    prices: [],
                    dataQuality: { status: 'empty', observations: 0, missingSymbols: ['AAPL'] },
                    provenance: { provider: 'Price Service', mode: 'fallback', sourceType: 'market_data', degradationReason: 'market_data_unavailable' },
                },
            });
            return;
        }

        if (options?.priceMode === 'stale') {
            await route.fulfill({
                json: {
                    success: true,
                    count: 1,
                    prices: [
                        { symbol: 'AAPL', name: 'AAPL', price: 105, change24h: 2, changePercent24h: 1.94, updatedAt: Date.now(), source: 'stale:YahooFinance', freshnessStatus: 'stale' },
                    ],
                    dataQuality: { status: 'degraded', observations: 1, missingSymbols: [] },
                    provenance: { provider: 'stale:YahooFinance', mode: 'fallback', sourceType: 'market_data', degradationReason: 'stale_quotes_present' },
                },
            });
            return;
        }

        await route.fulfill({
            json: {
                success: true,
                prices: [
                    { symbol: 'AAPL', name: 'Apple Inc.', price: 105, change24h: 1.28, changePercent24h: 1.23, updatedAt: Date.now(), source: 'YahooFinance' },
                    { symbol: 'NVDA', name: 'NVIDIA Corp.', price: 900, change24h: 25, changePercent24h: 2.8, updatedAt: Date.now(), source: 'YahooFinance' },
                ],
            },
        });
    };

    await page.route('**/api/news/prices?*', fulfillPrices);
    await page.route('**/api/news/prices', fulfillPrices);

    await page.route('**/api/teams', async (route) => {
        await route.fulfill({ json: { success: true, teams: [activeTeam], activeTeamId: activeTeam.teamId } });
    });

    await page.route('**/api/teams/team-1/switch', async (route) => {
        await route.fulfill({
            json: {
                success: true,
                token: 'test-token',
                teamContext: activeTeam,
                user: { id: 'user-1', email: 'test@example.com', role: activeTeam.role, teamContext: activeTeam },
            },
        });
    });

    await page.route('**/api/teams/team-1/members', async (route) => {
        if (route.request().method() === 'POST') {
            const body = JSON.parse(route.request().postData() ?? '{}');
            const member = {
                id: `tm-${teamMembers.length + 1}`,
                userId: `user-${teamMembers.length + 1}`,
                email: body.email,
                name: '',
                role: body.role ?? 'ANALYST',
                createdAt: new Date().toISOString(),
            };
            teamMembers = [...teamMembers, member];
            await route.fulfill({ status: 201, json: { success: true, membership: member } });
            return;
        }
        await route.fulfill({ json: { success: true, members: teamMembers } });
    });

    await page.route('**/api/teams/team-1/members/*', async (route) => {
        const userId = route.request().url().split('/').pop();
        if (route.request().method() === 'PATCH') {
            const body = JSON.parse(route.request().postData() ?? '{}');
            teamMembers = teamMembers.map((member) => member.userId === userId ? { ...member, role: body.role } : member);
            await route.fulfill({ json: { success: true } });
            return;
        }
        if (route.request().method() === 'DELETE') {
            teamMembers = teamMembers.filter((member) => member.userId !== userId);
            await route.fulfill({ json: { success: true } });
            return;
        }
        await route.fallback();
    });

    await page.route('**/api/portfolio/state', async (route) => {
        await route.fulfill({
            json: {
                success: true,
                portfolio: portfolioState,
            },
        });
    });

    await page.route('**/api/portfolio/trade', async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        const qty = Number(body.quantity);
        const price = Number(body.price);
        const position = portfolioState.positions.find((item) => item.ticker === body.ticker);
        if (body.type === 'SELL' && (!position || position.quantity < qty)) {
            await route.fulfill({ status: 400, json: { success: false, error: 'Insufficient position quantity' } });
            return;
        }
        if (body.type === 'SELL' && position) {
            position.quantity -= qty;
            portfolioState.cashBalance += qty * price;
            if (position.quantity <= 0) {
                portfolioState.positions = portfolioState.positions.filter((item) => item.id !== position.id);
            }
        }
        portfolioState.transactions.unshift({ id: `tx-${Date.now()}`, ticker: body.ticker, type: body.type, quantity: qty, price, commission: 0, timestamp: new Date().toISOString() });
        await route.fulfill({ json: { success: true, portfolio: portfolioState } });
    });

    await page.route('**/api/portfolio/risk?*', async (route) => {
        await route.fulfill({
            json: {
                success: true,
                risk: {
                    range: '24M',
                    confidence: 95,
                    horizonDays: 1,
                    generatedAt: new Date().toISOString(),
                    equity: 100500,
                    marketValue: 10500,
                    metrics: {
                        historicalVaR: 420,
                        historicalVaRPercent: 0.42,
                        parametricVaR: 390,
                        parametricVaRPercent: 0.39,
                        monteCarloVaR: 450,
                        monteCarloVaRPercent: 0.45,
                        expectedShortfall: 610,
                        expectedShortfallPercent: 0.61,
                        annualizedVolatility: 18.4,
                    },
                    concentration: [{ ticker: 'AAPL', weight: 1, marketValue: 10500, assetClass: 'EQUITY' }],
                    factorExposure: { EQUITY: 1 },
                    scenarios: [
                        { id: 'equity_selloff', name: 'Broad Equity Selloff', portfolioImpact: -1890, portfolioImpactPercent: -1.88, varAfter: 2310 },
                    ],
                    correlationMatrix: [{ symbol: 'AAPL', correlations: { AAPL: 1 } }],
                    dataQuality: { observations: 252, missingSymbols: [], status: 'ready' },
                },
            },
        });
    });

    await page.route('**/api/compliance/summary', async (route) => {
        await route.fulfill({ json: complianceSummary });
    });

    await page.route('**/api/ai/analyze', async (route) => {
        const request = route.request();
        const body = JSON.parse(request.postData() ?? '{}');
        await route.fulfill({
            json: {
                success: true,
                mode: options?.analyzeMode ?? 'live',
                reason: options?.analyzeMode === 'simulation' ? 'ai_simulation' : null,
                notice: options?.analyzeNotice,
                score: 72,
                scoreRationale: 'Fixture rationale',
                sentiment: 'POSITIVE',
                summary: `Fixture summary for ${body.headline ?? 'headline'}`,
                affectedAssets: ['NVDA'],
            },
        });
    });
}

test('@smoke dashboard shows runtime badges and manual refresh without legacy mock contract text', async ({ page }) => {
    await mockBaseApp(page);

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('runtime-status')).toHaveText('Runtime Online');
    await expect(page.getByTestId('runtime-badge-backend')).toContainText('Backend: Online');
    await expect(page.getByTestId('runtime-badge-ai')).toContainText('AI: Live AI');
    await expect(page.getByTestId('runtime-badge-feed')).toContainText('Feed: Live Feed');
    await expect(page.getByTestId('runtime-badge-quant')).toContainText('Quant: Price Model Standby');
    await expect(page.getByTestId('runtime-badge-compliance')).toContainText('Compliance: Dataset Active');
    await expect(page.getByText('POSITIVE')).toHaveCount(3);
    await expect(page.getByText(/mock contract/i)).toHaveCount(0);
    await expect(page.getByText(/Quant unavailable \(connection refused\)/i)).toHaveCount(0);

    const refreshRequest = page.waitForRequest((request) =>
        request.url().includes('/api/news/feed')
        && request.url().includes('limit=3')
        && request.url().includes('refresh=1')
    );
    await page.getByRole('button', { name: 'Fetch Latest' }).click();
    await expect(page.getByRole('button', { name: 'Fetching...' })).toBeDisabled();
    await refreshRequest;
    await expect(page.getByText('Manual refresh delivers new market intelligence')).toBeVisible();
});

// Separate test: one test = one behaviour (isolation + parallel runs); it had no dependency on the dashboard (separate page load).
test('@smoke compliance shows dataset status, version, hash and freshness', async ({ page }) => {
    await mockBaseApp(page);

    await page.goto('/compliance', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('compliance-dataset-status')).toHaveText('Dataset Active', { timeout: 20_000 });
    await expect(page.getByTestId('compliance-version')).toHaveText('v1');
    await expect(page.getByTestId('compliance-updated')).not.toBeEmpty();
    await expect(page.getByTestId('compliance-hash')).toHaveText('1b9451ec86ff7693');
    await expect(page.getByTestId('compliance-freshness')).not.toBeEmpty();
    await expect(page.getByText(/mock contract/i)).toHaveCount(0);
});

test('@smoke war room shows degrade notice and standby state with partial backend failures', async ({ page }) => {
    await mockBaseApp(page);

    await page.route('**/api/ai/agent-analysis', async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        if (body.agentId === 'agent-risk' || body.agentId === 'agent-quant') {
            await route.fulfill({
                status: 504,
                json: {
                    success: false,
                    reason: 'backend_timeout',
                    failureStage: 'model',
                    notice: 'Live War Room analysis took too long; using local fallback debate output where needed.',
                },
            });
            return;
        }

        await route.fulfill({
            json: {
                success: true,
                agentId: body.agentId,
                agentName: body.agentId,
                position: 'LONG',
                confidence: 61,
                reasoning: 'Live fixture reasoning.',
                evidence: ['Fixture evidence'],
                scenarios: [],
                mode: 'live',
                reason: null,
                notice: null,
                timestamp: Date.now(),
            },
        });
    });

    await page.route('**/api/quant/**', async (route) => {
        await route.fulfill({ status: 503, json: { error: 'quant unavailable' } });
    });

    await page.goto('/war-room', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('war-room-topic-n1').click();

    await expect(page.getByTestId('war-room-notice')).toContainText('Partial live analysis');
    await expect(page.getByTestId('war-room-notice')).toContainText('2 live');
    await expect(page.getByTestId('war-room-notice')).toContainText('2 degraded');
    await expect(page.getByText('Backend War Room analysis failed')).toHaveCount(0);
    await expect(page.getByTestId('war-room-agent-agent-risk')).toContainText('Timeout: Live War Room analysis took too long');
    await expect(page.getByText('Projected Trajectory')).toHaveCount(0);
    await expect(page.getByTestId('war-room-agent-agent-bear')).toBeVisible();
    await expect(page.getByTestId('war-room-agent-agent-risk')).toBeVisible();
    await expect(page.getByTestId('war-room-quant-summary')).toContainText('Quant target unavailable');
    await expect(page.getByTestId('war-room-quant-summary')).toContainText('HEURISTIC');
    await expect(page.getByTestId('war-room-quant-standby')).toHaveCount(0);
});

test('@smoke portfolio shows local live chart and derived tick pricing', async ({ page }) => {
    await mockBaseApp(page);

    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('portfolio-live-chart')).toBeVisible();
    await expect(page.getByTestId('portfolio-live-chart')).toContainText('AAPL');
    await expect(page.getByTestId('portfolio-live-chart')).toContainText('$105.00');
    await expect(page.getByTestId('portfolio-live-chart')).toContainText('+1.23%');
    await expect(page.getByTestId('portfolio-live-chart')).toContainText('Holding P&L +5.00%');
    await expect(page.getByTestId('portfolio-live-chart').getByText('LIVE', { exact: true })).toBeVisible();
    await expect(page.getByTestId('portfolio-price-chart-canvas').locator('canvas').first()).toBeVisible();
    await expect(page.getByTestId('portfolio-timeframe-24M')).toBeVisible();
    await expect(page.getByTestId('portfolio-risk-panel')).toContainText('Historical VaR 95%');
    await expect(page.getByTestId('portfolio-live-chart')).toContainText('24M return');
    await expect(page.getByTestId('portfolio-history-collecting')).toHaveCount(0);
});

test('@smoke portfolio shows stale real prices when live quotes fall back to history', async ({ page }) => {
    await mockBaseApp(page, { priceMode: 'stale' });

    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('portfolio-live-chart')).toContainText('STALE');
    await expect(page.getByTestId('portfolio-live-chart')).toContainText('$105.00');
    await expect(page.getByTestId('portfolio-live-chart')).toContainText('Stale YahooFinance');
    await expect(page.getByTestId('portfolio-live-chart')).not.toContainText('UNAVAILABLE');
    await expect(page.getByTestId('portfolio-live-chart')).not.toContainText('SIM');
    await expect(page.getByTestId('portfolio-price-chart-canvas').locator('canvas').first()).toBeVisible();
});

test('@smoke portfolio shows unavailable instead of fake prices when providers fail', async ({ page }) => {
    await mockBaseApp(page, { priceMode: 'unavailable' });

    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('portfolio-live-chart')).toContainText('UNAVAILABLE');
    await expect(page.getByTestId('portfolio-live-chart')).toContainText('Live quotes unavailable. No simulated prices are shown.');
    await expect(page.getByTestId('portfolio-live-chart')).not.toContainText('SIM');
    await expect(page.getByTestId('portfolio-price-chart-canvas').locator('canvas').first()).toBeVisible();
});

test('@smoke portfolio sells an open position and records the transaction', async ({ page }) => {
    await mockBaseApp(page);

    await page.goto('/portfolio', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Sell', exact: true }).click();
    await page.getByRole('button', { name: 'LOG PAPER SELL' }).click();

    await expect(page.getByRole('cell', { name: 'SELL', exact: true })).toBeVisible();
    await expect(page.getByText('Available: 100')).toHaveCount(0);
});

test('@smoke team admin can view and add existing team members', async ({ page }) => {
    await mockBaseApp(page, { teamRole: 'ADMIN' });

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Team Governance/ }).click();

    await expect(page.getByText('member@example.com')).toBeVisible();
    await page.getByPlaceholder('member@example.com').fill('newmember@example.com');
    await page.getByRole('button', { name: /Add Existing User/ }).click();
    await expect(page.getByText('newmember@example.com')).toBeVisible();
});

test('@smoke war room shows quant summary when quant becomes ready', async ({ page }) => {
    await mockBaseApp(page, {
        runtime: {
            services: {
                ai: 'live',
                quant: 'reachable',
                compliance: 'ready',
            },
            diagnostics: {
                quant: {
                    reason: null,
                    checkedAt: '2026-04-18T12:00:00.000Z',
                },
                compliance: {
                    source: 'local-file',
                    reason: null,
                    loadedAt: '2026-04-18T12:00:00.000Z',
                },
            },
        },
    });

    await page.route('**/api/ai/agent-analysis', async (route) => {
        const body = JSON.parse(route.request().postData() ?? '{}');
        await route.fulfill({
            json: {
                success: true,
                agentId: body.agentId,
                agentName: body.agentId,
                position: 'LONG',
                confidence: 68,
                reasoning: 'Live fixture reasoning.',
                evidence: ['Fixture evidence'],
                scenarios: [],
                mode: 'live',
                reason: null,
                notice: null,
                timestamp: Date.now(),
            },
        });
    });

    await page.route('**/api/quant/**', async (route) => {
        const url = route.request().url();
        const data = url.includes('short-term')
            ? {
                current_price: 273.55,
                median_target: 318.23,
                upper_target_10pct: 360,
                lower_target_10pct: 168,
                var_95: 92,
                recommended_kelly_bet: 0.08,
                path_trajectories: [
                    [240, 273.55, 300],
                    [220, 260, 315],
                    [180, 202, 360],
                ],
            }
            : url.includes('medium-term')
                ? {
                    current_price: 100,
                    target_6_12_months: 118,
                    lower_band: 91,
                    upper_band: 130,
                    forecast_path: [100, 103, 107, 112, 118],
                }
                : {
                    current_price: 100,
                    target_12_36_months: 135,
                    lower_band: 92,
                    upper_band: 148,
                    fama_french_premium: 0.08,
                };
        await route.fulfill({
            json: {
                data,
            },
        });
    });

    await page.goto('/war-room', { waitUntil: 'domcontentloaded' });
    await page.getByTestId('war-room-topic-n1').click();

    await expect(page.getByTestId('war-room-quant-summary')).toBeVisible();
    await expect(page.getByTestId('war-room-projection-chart')).toContainText('DCF Implied Growth Path');
    await expect(page.getByTestId('war-room-projection-chart')).toContainText('DCF/FAMA');
    await expect(page.getByTestId('war-room-quant-standby')).toHaveCount(0);

    await page.getByTestId('war-room-horizon-medium').click();
    await page.getByTestId('war-room-topic-n1').click();
    await expect(page.getByTestId('war-room-projection-chart')).toContainText('ARIMAX & GARCH Projection');
    await expect(page.getByTestId('war-room-projection-chart')).toContainText('ARIMAX/GARCH');

    await page.getByTestId('war-room-horizon-short').click();
    await page.getByTestId('war-room-topic-n1').click();
    await expect(page.getByTestId('war-room-projection-chart')).toContainText('Monte Carlo GBM Trajectory');
    await expect(page.getByTestId('war-room-projection-chart')).toContainText('MONTE CARLO');
    await expect(page.getByTestId('war-room-quant-summary')).toContainText('$318.23');
    await expect(page.getByTestId('war-room-projection-chart')).toContainText('$318.23');
    await expect(page.getByTestId('war-room-projection-chart')).not.toContainText('$202.00');
});
