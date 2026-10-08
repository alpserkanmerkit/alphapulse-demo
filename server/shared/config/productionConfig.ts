export interface ProductionConfigCheck {
    key: 'jwtSecret' | 'corsOrigins' | 'databaseUrl' | 'quantEngineUrl' | 'redisForExport' | 'durableCache';
    ready: boolean;
    required: boolean;
}

export interface ProductionConfigStatus {
    ready: boolean;
    checks: Record<ProductionConfigCheck['key'], boolean>;
    missing: ProductionConfigCheck['key'][];
}

const REQUIRED_PRODUCTION_ENV: Array<[ProductionConfigCheck['key'], string]> = [
    ['jwtSecret', 'JWT_SECRET'],
    ['corsOrigins', 'CORS_ORIGINS'],
    ['databaseUrl', 'DATABASE_URL'],
    ['quantEngineUrl', 'QUANT_ENGINE_URL'],
];

function hasEnv(name: string): boolean {
    return Boolean(process.env[name]?.trim());
}

export function getProductionConfigStatus(): ProductionConfigStatus {
    const production = process.env.NODE_ENV === 'production';
    const entries: ProductionConfigCheck[] = REQUIRED_PRODUCTION_ENV.map(([key, envName]): ProductionConfigCheck => ({
        key,
        ready: production ? hasEnv(envName) : true,
        required: production,
    }));

    const exportRequiresRedis = production && process.env.PDF_EXPORT_ENABLED === 'true';
    entries.push({
        key: 'redisForExport',
        ready: exportRequiresRedis ? hasEnv('REDIS_URL') : true,
        required: exportRequiresRedis,
    });

    const durableCacheRequired = production && process.env.REQUIRE_DURABLE_CACHE === 'true';
    entries.push({
        key: 'durableCache',
        ready: durableCacheRequired ? hasEnv('REDIS_URL') : true,
        required: durableCacheRequired,
    });
    const missing = entries.filter((entry) => !entry.ready).map((entry) => entry.key);

    return {
        ready: missing.length === 0,
        checks: Object.fromEntries(entries.map((entry) => [entry.key, entry.ready])) as ProductionConfigStatus['checks'],
        missing,
    };
}
