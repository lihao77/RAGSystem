import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { POSTGRES_ANALYTICS_MIGRATIONS } from "./analytics-schema.js";

const ADVISORY_LOCK_ID = 0x52414741;

export async function runPostgresAnalyticsMigrations(executor: PostgresMemoryExecutor): Promise<void> {
  await executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_ID]);
    await tx.query(`CREATE TABLE IF NOT EXISTS ragsystem_analytics_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const applied = await tx.query<{ version: number | string; name: string }>(
      "SELECT version, name FROM ragsystem_analytics_schema_migrations ORDER BY version ASC",
    );
    for (let index = 0; index < applied.rows.length; index += 1) {
      const row = applied.rows[index];
      const expected = POSTGRES_ANALYTICS_MIGRATIONS[index];
      if (!row || !expected || Number(row.version) !== expected.version || row.name !== expected.name) {
        throw new Error(`invalid PostgreSQL analytics migration history at version ${String(row?.version ?? index + 1)}`);
      }
    }
    for (const migration of POSTGRES_ANALYTICS_MIGRATIONS.slice(applied.rows.length)) {
      await tx.query(migration.sql);
      await tx.query(
        "INSERT INTO ragsystem_analytics_schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    }
  });
}
