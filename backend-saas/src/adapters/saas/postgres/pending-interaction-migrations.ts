import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { POSTGRES_PENDING_INTERACTION_MIGRATIONS } from "./pending-interaction-schema.js";

export async function runPostgresPendingInteractionMigrations(
  executor: PostgresMemoryExecutor,
): Promise<{ current_version: number; applied_versions: number[] }> {
  return executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [0x52414749]);
    await tx.query(`CREATE TABLE IF NOT EXISTS ragsystem_pending_interaction_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const applied = await tx.query<{ version: number | string; name: string }>(
      "SELECT version,name FROM ragsystem_pending_interaction_schema_migrations ORDER BY version",
    );
    for (let index = 0; index < applied.rows.length; index += 1) {
      const expected = POSTGRES_PENDING_INTERACTION_MIGRATIONS[index];
      const actual = applied.rows[index];
      if (!expected || Number(actual?.version) !== expected.version || actual?.name !== expected.name) {
        throw new Error("invalid PostgreSQL pending interaction migration history");
      }
    }
    const pending = POSTGRES_PENDING_INTERACTION_MIGRATIONS.slice(applied.rows.length);
    for (const migration of pending) {
      await tx.query(migration.sql);
      await tx.query(
        "INSERT INTO ragsystem_pending_interaction_schema_migrations(version,name) VALUES($1,$2)",
        [migration.version, migration.name],
      );
    }
    return {
      current_version: POSTGRES_PENDING_INTERACTION_MIGRATIONS.length,
      applied_versions: pending.map((migration) => migration.version),
    };
  });
}
