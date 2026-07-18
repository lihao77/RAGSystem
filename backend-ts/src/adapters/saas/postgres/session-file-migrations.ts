import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { POSTGRES_SESSION_FILE_MIGRATIONS } from "./session-file-schema.js";

export async function runPostgresSessionFileMigrations(executor: PostgresMemoryExecutor): Promise<void> {
  await executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [0x52414746]);
    await tx.query("CREATE TABLE IF NOT EXISTS ragsystem_session_file_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const applied = await tx.query<{ version: number | string; name: string }>("SELECT version,name FROM ragsystem_session_file_schema_migrations ORDER BY version");
    for (let i = 0; i < applied.rows.length; i += 1) {
      const expected = POSTGRES_SESSION_FILE_MIGRATIONS[i];
      if (!expected || Number(applied.rows[i]?.version) !== expected.version || applied.rows[i]?.name !== expected.name) {
        throw new Error("invalid PostgreSQL session file migration history");
      }
    }
    for (const migration of POSTGRES_SESSION_FILE_MIGRATIONS.slice(applied.rows.length)) {
      await tx.query(migration.sql);
      await tx.query("INSERT INTO ragsystem_session_file_schema_migrations(version,name) VALUES($1,$2)", [migration.version, migration.name]);
    }
  });
}
