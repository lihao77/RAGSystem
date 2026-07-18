import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { POSTGRES_BACKGROUND_TASK_MIGRATIONS } from "./background-task-schema.js";

const ADVISORY_LOCK_ID = 0x52414742;

export async function runPostgresBackgroundTaskMigrations(executor: PostgresMemoryExecutor): Promise<void> {
  await executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_ID]);
    await tx.query(`CREATE TABLE IF NOT EXISTS ragsystem_background_task_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const applied = await tx.query<{ version: number | string; name: string }>(
      "SELECT version, name FROM ragsystem_background_task_schema_migrations ORDER BY version ASC",
    );
    for (let index = 0; index < applied.rows.length; index += 1) {
      const row = applied.rows[index];
      const expected = POSTGRES_BACKGROUND_TASK_MIGRATIONS[index];
      if (!row || !expected || Number(row.version) !== expected.version || row.name !== expected.name) {
        throw new Error(`invalid PostgreSQL background-task migration history at version ${String(row?.version ?? index + 1)}`);
      }
    }
    for (const migration of POSTGRES_BACKGROUND_TASK_MIGRATIONS.slice(applied.rows.length)) {
      await tx.query(migration.sql);
      await tx.query(
        "INSERT INTO ragsystem_background_task_schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
    }
  });
}
