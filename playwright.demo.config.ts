import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// `npm run test:demo`: starts the real `npm run demo` (server in demo mode + Vite); no request is mocked.
// Browser: the preinstalled Google Chrome on CI (PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH), the environment's Chromium locally; otherwise Playwright's own.
const browserCandidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_BROWSERS_PATH ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium` : undefined,
].filter(Boolean) as string[];
const executablePath = browserCandidates.find((candidate) => existsSync(candidate));

export default defineConfig({
    testDir: './e2e-demo',
    outputDir: 'output/playwright/test-results',
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 1,
    reporter: process.env.CI ? [['list'], ['github']] : 'list',
    timeout: 60_000,
    expect: { timeout: 10_000 },
    use: {
        baseURL: 'http://127.0.0.1:3000',
        trace: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], launchOptions: executablePath ? { executablePath } : undefined },
        },
    ],
    webServer: {
        command: 'npm run demo',
        // scripts/demo.ts prints the "READY" line once both the server AND the UI are up (waiting only on the UI port would skip the API).
        wait: { stdout: /\[demo\] READY/ },
        stdout: 'pipe',
        stderr: 'pipe',
        // Risk of a dirty/stale process: always start a fresh demo.
        reuseExistingServer: false,
        timeout: 120_000,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
});
