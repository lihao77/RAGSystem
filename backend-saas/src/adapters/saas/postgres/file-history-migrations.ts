import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { POSTGRES_FILE_HISTORY_MIGRATIONS } from "./file-history-schema.js";

export async function runPostgresFileHistoryMigrations(executor: PostgresMemoryExecutor): Promise<void> {
  await executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [0x52414648]);
    await tx.query("CREATE TABLE IF NOT EXISTS ragsystem_file_history_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const applied = await tx.query<{ version: number | string; name: string }>("SELECT version,name FROM ragsystem_file_history_schema_migrations ORDER BY version");
    for (let index = 0; index < applied.rows.length; index += 1) {
      const expected = POSTGRES_FILE_HISTORY_MIGRATIONS[index];
      if (!expected || Number(applied.rows[index]?.version) !== expected.version || applied.rows[index]?.name !== expected.name) {
        throw new Error("invalid PostgreSQL file history migration history");
      }
    }
    for (const migration of POSTGRES_FILE_HISTORY_MIGRATIONS.slice(applied.rows.length)) {
      await tx.query(migration.sql);
      await tx.query("INSERT INTO ragsystem_file_history_schema_migrations(version,name) VALUES($1,$2)", [migration.version, migration.name]);
    }
  });
}
