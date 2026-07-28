import { POSTGRES_RUN_MIGRATIONS } from "./run-schema.js";
import type { PostgresExecutor } from "./postgres-executor.js";

const ADVISORY_LOCK_ID = 0x52414752;

interface AppliedMigrationRow extends Record<string, unknown> {
  version: number | string;
  name: string;
}

export interface PostgresRunMigrationResult {
  previous_version: number;
  current_version: number;
  applied_versions: number[];
}

export async function runPostgresRunMigrations(executor: PostgresExecutor): Promise<PostgresRunMigrationResult> {
  return executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_ID]);
    await tx.query(`CREATE TABLE IF NOT EXISTS ragsystem_run_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const applied = await tx.query<AppliedMigrationRow>(
      "SELECT version, name FROM ragsystem_run_schema_migrations ORDER BY version ASC",
    );
    for (let i = 0; i < applied.rows.length; i += 1) {
      const row = applied.rows[i];
      const expected = POSTGRES_RUN_MIGRATIONS[i];
      if (!row || !expected || Number(row.version) !== expected.version || String(row.name) !== expected.name) {
        throw new Error(`invalid PostgreSQL run migration history at version ${String(row?.version ?? i + 1)}`);
      }
    }
    const pending = POSTGRES_RUN_MIGRATIONS.slice(applied.rows.length);
    for (const migration of pending) {
      await tx.query(migration.sql);
      await tx.query("INSERT INTO ragsystem_run_schema_migrations (version, name) VALUES ($1, $2)", [migration.version, migration.name]);
    }
    return { previous_version: applied.rows.length, current_version: POSTGRES_RUN_MIGRATIONS.length, applied_versions: pending.map((m) => m.version) };
  });
}
