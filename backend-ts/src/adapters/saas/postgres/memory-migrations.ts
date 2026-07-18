import { POSTGRES_MEMORY_MIGRATIONS } from "./memory-schema.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";

const MEMORY_MIGRATION_ADVISORY_LOCK_ID = 0x5241474d;

interface AppliedMigrationRow extends Record<string, unknown> {
  version: number | string;
  name: string;
}

export interface PostgresMemoryMigrationResult {
  previous_version: number;
  current_version: number;
  applied_versions: number[];
}

/** Applies all pending memory migrations while serializing concurrent starters. */
export async function runPostgresMemoryMigrations(
  executor: PostgresMemoryExecutor,
): Promise<PostgresMemoryMigrationResult> {
  return executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MEMORY_MIGRATION_ADVISORY_LOCK_ID]);
    await tx.query(`
      CREATE TABLE IF NOT EXISTS ragsystem_memory_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const applied = await tx.query<AppliedMigrationRow>(
      "SELECT version, name FROM ragsystem_memory_schema_migrations ORDER BY version ASC",
    );
    for (let index = 0; index < applied.rows.length; index += 1) {
      const row = applied.rows[index];
      const expected = POSTGRES_MEMORY_MIGRATIONS[index];
      if (row == null || expected == null
        || Number(row.version) !== expected.version
        || String(row.name) !== expected.name) {
        throw new Error(`invalid PostgreSQL memory migration history at version ${String(row?.version ?? index + 1)}`);
      }
    }

    const previousVersion = applied.rows.length;
    const pending = POSTGRES_MEMORY_MIGRATIONS.slice(previousVersion);
    for (const migration of pending) {
      await tx.query(migration.sql);
      await tx.query(
        "INSERT INTO ragsystem_memory_schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    }

    return {
      previous_version: previousVersion,
      current_version: POSTGRES_MEMORY_MIGRATIONS.length,
      applied_versions: pending.map((migration) => migration.version),
    };
  });
}
