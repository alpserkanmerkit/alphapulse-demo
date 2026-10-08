import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@libsql/client';

const databaseUrl = process.env.DATABASE_URL || 'file:./prisma/dev.db';
if (!databaseUrl.startsWith('file:')) {
  throw new Error('Local migration fallback only supports file: SQLite/libSQL DATABASE_URL values.');
}

const migrationsDir = 'prisma/migrations';
if (!existsSync(migrationsDir)) {
  throw new Error(`Missing migrations directory: ${migrationsDir}`);
}

const db = createClient({ url: databaseUrl });

await db.execute(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "checksum" TEXT NOT NULL,
  "finished_at" DATETIME,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`);

const applied = await db.execute('SELECT "migration_name" FROM "_prisma_migrations" WHERE "rolled_back_at" IS NULL');
const appliedNames = new Set(applied.rows.map((row) => String(row.migration_name)));
const migrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

let appliedCount = 0;
for (const migrationName of migrations) {
  if (appliedNames.has(migrationName)) {
    continue;
  }

  const migrationPath = join(migrationsDir, migrationName, 'migration.sql');
  const sql = readFileSync(migrationPath, 'utf8');
  const statements = sql.split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean);

  for (const statement of statements) {
    await db.execute(statement);
  }

  const checksum = createHash('sha256').update(sql).digest('hex');
  await db.execute({
    sql: 'INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "applied_steps_count") VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, ?)',
    args: [migrationName, checksum, migrationName, statements.length],
  });
  appliedCount += 1;
  console.log(`[db:migrate:fallback] Applied ${migrationName}`);
}

db.close();
console.log(`[db:migrate:fallback] ${appliedCount} migration(s) applied.`);
