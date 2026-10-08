import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// On CI (ubuntu-latest) the preinstalled Google Chrome is used: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome
// (.github/workflows/ci.yml 'smoke' job) -> `playwright install` (~20-30 s) is skipped. Otherwise Playwright's own Chromium is used.
const browserCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean) as string[];

const chromiumExecutablePath = browserCandidates.find((candidate) => existsSync(candidate));

export default defineConfig({
    testDir: './e2e',
    outputDir: 'output/playwright/test-results',
    // Each test runs in its own context with the whole network mocked (e2e/smoke.spec.ts) -> tests are independent
    // of each other; fullyParallel also spreads tests within one file across workers. Measured (local, 4 cores): 17.7s (1 worker) -> 10.3s (2 workers).
    // On CI (ubuntu-latest, 2 vCPU) 2 workers were SLOWER (21.0s vs 19.2s, experiment run 37672054775) -> 1 worker on CI;
    // this also matches Playwright's CI recommendation: https://playwright.dev/docs/ci
    // Source: https://playwright.dev/docs/best-practices ("Use parallelism and sharding", "Make tests as isolated as possible").
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    // trace 'on-first-retry' only records a trace when a retry happens; 1 retry on CI, so flaky tests show up as "flaky" in the report.
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? [['list'], ['github']] : 'list',
    timeout: 30_000,
    expect: {
        timeout: 5_000,
    },
    use: {
        baseURL: 'http://127.0.0.1:3000',
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : undefined,
            },
        },
    ],
    webServer: {
        command: 'npm run dev -- --host 127.0.0.1 --port 3000',
        url: 'http://127.0.0.1:3000',
        // On CI never reuse an already running server (risk of a stale/dirty process); reuse it locally for a fast loop.
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
});
