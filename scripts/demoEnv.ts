import { randomBytes } from 'node:crypto';

export interface DemoEnvOptions {
    apiPort: number;
    uiPort: number;
    databaseUrl: string;
}

// Environment for the `npm run demo` child processes. JWT_SECRET is generated randomly per run, private to the process
// (no fixed secret in the repo/environment; never inherited from the environment). The F-1 rule (>=32 bytes) still applies on the server.
export function buildDemoEnv(base: NodeJS.ProcessEnv, options: DemoEnvOptions): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base };
    delete env.GEMINI_API_KEY;
    delete env.REDIS_URL;

    env.JWT_SECRET = randomBytes(48).toString('hex');
    env.DEMO_MODE = '1';
    env.VITE_DEMO_MODE = '1';
    env.NODE_ENV = env.NODE_ENV === 'production' ? 'development' : (env.NODE_ENV ?? 'development');
    env.PDF_EXPORT_ENABLED = 'false';
    env.EXPORT_QUEUE_ENABLED = 'false';
    env.ENABLE_DB_GC = 'false';
    env.DATABASE_URL = options.databaseUrl;
    env.SERVER_PORT = String(options.apiPort);
    env.VITE_API_BASE_URL = `http://127.0.0.1:${options.apiPort}`;
    env.CORS_ORIGINS = `http://127.0.0.1:${options.uiPort},http://localhost:${options.uiPort}`;
    return env;
}
