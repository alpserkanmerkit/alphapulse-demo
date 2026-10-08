// Demo mode: runs on sample data without calling external services (RSS, CoinGecko, Yahoo/quant bridge, Gemini, Redis).
// Explicit switch: DEMO_MODE=1|true. Without a key (GEMINI_API_KEY empty) and outside production it turns on automatically at server startup.

export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.DEMO_MODE === '1' || env.DEMO_MODE === 'true';
}

export function resolveDemoMode(env: NodeJS.ProcessEnv = process.env): { demo: boolean; auto: boolean } {
    if (isDemoMode(env)) return { demo: true, auto: false };
    if (env.DEMO_MODE === '0' || env.DEMO_MODE === 'false') return { demo: false, auto: false };
    // In production a missing key never silently falls back to fake data.
    if (!env.GEMINI_API_KEY && env.NODE_ENV !== 'production') return { demo: true, auto: true };
    return { demo: false, auto: false };
}

// The demo process uses no external service keys: keys/Redis are removed from the environment and the PDF queue is disabled.
export function enterDemoMode(env: NodeJS.ProcessEnv = process.env): void {
    env.DEMO_MODE = '1';
    delete env.GEMINI_API_KEY;
    delete env.REDIS_URL;
    env.PDF_EXPORT_ENABLED = 'false';
    env.EXPORT_QUEUE_ENABLED = 'false';
}
