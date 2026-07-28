import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { POSTGRES_WORKFLOW_TASK_MIGRATIONS } from "./workflow-task-schema.js";

const ADVISORY_LOCK_ID = 0x52414757;

export async function runPostgresWorkflowTaskMigrations(executor: PostgresMemoryExecutor): Promise<{
  current_version: number;
  applied_versions: number[];
}> {
  return executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [ADVISORY_LOCK_ID]);
    await tx.query(`CREATE TABLE IF NOT EXISTS ragsystem_workflow_task_schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const applied = await tx.query<{ version: number | string; name: string }>(
      "SELECT version,name FROM ragsystem_workflow_task_schema_migrations ORDER BY version",
    );
    for (let index = 0; index < applied.rows.length; index += 1) {
      const row = applied.rows[index];
      const expected = POSTGRES_WORKFLOW_TASK_MIGRATIONS[index];
      if (!row || !expected || Number(row.version) !== expected.version || row.name !== expected.name) {
        throw new Error("invalid PostgreSQL workflow task migration history");
      }
    }
    const pending = POSTGRES_WORKFLOW_TASK_MIGRATIONS.slice(applied.rows.length);
    for (const migration of pending) {
      await tx.query(migration.sql);
      await tx.query(
        "INSERT INTO ragsystem_workflow_task_schema_migrations(version,name) VALUES($1,$2)",
        [migration.version, migration.name],
      );
    }
    return {
      current_version: POSTGRES_WORKFLOW_TASK_MIGRATIONS.length,
      applied_versions: pending.map((migration) => migration.version),
    };
  });
}
