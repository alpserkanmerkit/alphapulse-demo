import type { AddressInfo } from 'node:net';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { afterAll, vi } from 'vitest';

const defaultComplianceDatasetPath = join(process.cwd(), 'server/data/compliance-snapshot.json');

type EnvSnapshot = Record<string, string | undefined>;

interface BackendTestServerOptions {
    beforeImport?: () => void;
    env?: Record<string, string | undefined>;
    jwtSecret?: string;
    restoreDatabaseUrlBeforeHandler?: boolean;
    seedCompliance?: boolean;
    seedComplianceDatasetPath?: string;
}

function snapshotEnv(keys: string[]): EnvSnapshot {
    return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: EnvSnapshot) {
    for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

async function applyMigration(databaseUrl: string) {
    const db = createClient({ url: databaseUrl });
    const migrations = readdirSync('prisma/migrations', { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();

    try {
        for (const migrationName of migrations) {
            const sql = readFileSync(join('prisma/migrations', migrationName, 'migration.sql'), 'utf8');
            const statements = sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean);
            for (const statement of statements) {
                await db.execute(statement);
            }
        }
    } finally {
        db.close();
    }
}

// Migrations are applied once per worker process into a template database; every test then
// gets a byte-for-byte copy instead of replaying all migration statements (~70 ms per test).
let migratedTemplate: { dir: string; path: string } | null = null;

// A `process.once('exit')` hook never runs in the vitest worker (it is terminated by signal), so the
// template directory leaked into the OS temp dir on every run. afterAll registered here, at module
// top level, belongs to every test file that imports this helper and does run.
afterAll(() => {
    if (!migratedTemplate) return;
    try {
        rmSync(migratedTemplate.dir, { recursive: true, force: true });
    } catch {
        // Best-effort cleanup of a temp directory.
    }
    migratedTemplate = null;
});

async function createMigratedDatabase(databasePath: string) {
    if (!migratedTemplate) {
        const dir = mkdtempSync(join(tmpdir(), 'alphapulse-test-template-'));
        const path = join(dir, 'template.db');
        await applyMigration(pathToFileURL(path).href);
        migratedTemplate = { dir, path };
    }
    copyFileSync(migratedTemplate.path, databasePath);
}

// analysisService simulates model latency with `setTimeout(800..1500 ms)`. The latency is not part of
// any asserted contract (tests only check that durationMs is a number), so collapse that window to 0.
// The window is deliberately narrow: 1500 ms exactly is the quant health timeout and must stay real.
function collapseSimulatedLatency() {
    const realSetTimeout = globalThis.setTimeout;
    return vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
    ) => realSetTimeout(
        callback,
        typeof delay === 'number' && delay >= 800 && delay < 1500 ? 0 : delay,
        ...args
    )) as unknown as typeof setTimeout);
}

async function removeFileIfPresent(path: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (!existsSync(path)) return;
        try {
            unlinkSync(path);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
}

async function removeDirectoryIfPresent(path: string) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        if (!existsSync(path)) return;
        try {
            rmSync(path, { recursive: true, force: true });
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
}

async function seedComplianceSnapshot(datasetPath: string) {
    const previousDatasetPath = process.env.COMPLIANCE_DATASET_PATH;
    process.env.COMPLIANCE_DATASET_PATH = datasetPath;
    try {
        const { getComplianceSummary } = await import('../../server/services/complianceRepository');
        await getComplianceSummary();
    } finally {
        if (previousDatasetPath === undefined) {
            delete process.env.COMPLIANCE_DATASET_PATH;
        } else {
            process.env.COMPLIANCE_DATASET_PATH = previousDatasetPath;
        }
    }
}

export async function withBackendTestServer(
    handler: (baseUrl: string) => Promise<void>,
    options: BackendTestServerOptions = {}
) {
    vi.resetModules();
    options.beforeImport?.();

    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const testArtifactDir = mkdtempSync(join(tmpdir(), 'alphapulse-test-'));
    const databasePath = join(testArtifactDir, `test-${suffix}.db`);
    const databaseUrl = pathToFileURL(databasePath).href;
    const mutableCompliancePath = join(testArtifactDir, `compliance-${suffix}.json`);
    const auditLogPath = join(testArtifactDir, `audit-${suffix}.jsonl`);
    const envKeys = [
        'NODE_ENV',
        'DATABASE_URL',
        'JWT_SECRET',
        'COMPLIANCE_MUTABLE_DATASET_PATH',
        'AUDIT_EVENT_LOG_PATH',
        ...Object.keys(options.env ?? {}),
    ];
    const envSnapshot = snapshotEnv([...new Set(envKeys)]);

    process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';
    process.env.DATABASE_URL = databaseUrl;
    if (options.jwtSecret !== undefined) {
        process.env.JWT_SECRET = options.jwtSecret;
    }
    process.env.COMPLIANCE_MUTABLE_DATASET_PATH = mutableCompliancePath;
    process.env.AUDIT_EVENT_LOG_PATH = auditLogPath;
    for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    await createMigratedDatabase(databasePath);
    const latencySpy = collapseSimulatedLatency();
    if (options.seedCompliance ?? true) {
        await seedComplianceSnapshot(options.seedComplianceDatasetPath ?? defaultComplianceDatasetPath);
    }

    const { createApp } = await import('../../server/index');
    const app = createApp();
    const server = await new Promise<import('node:http').Server>((resolve) => {
        const instance = app.listen(0, () => resolve(instance));
    });
    const { port } = server.address() as AddressInfo;
    if (options.restoreDatabaseUrlBeforeHandler) {
        const originalDatabaseUrl = envSnapshot.DATABASE_URL;
        if (originalDatabaseUrl === undefined) {
            delete process.env.DATABASE_URL;
        } else {
            process.env.DATABASE_URL = originalDatabaseUrl;
        }
    }

    try {
        await handler(`http://127.0.0.1:${port}`);
    } finally {
        latencySpy.mockRestore();
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        });
        const { prisma } = await import('../../server/shared/db/db');
        await prisma.$disconnect();
        vi.resetModules();
        await removeFileIfPresent(databasePath);
        await removeFileIfPresent(`${databasePath}-journal`);
        await removeFileIfPresent(mutableCompliancePath);
        await removeFileIfPresent(auditLogPath);
        await removeDirectoryIfPresent(testArtifactDir);
        restoreEnv(envSnapshot);
    }
}
