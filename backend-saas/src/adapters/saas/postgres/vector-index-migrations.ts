import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { POSTGRES_VECTOR_INDEX_MIGRATIONS } from "./vector-index-schema.js";

export async function runPostgresVectorIndexMigrations(executor: PostgresMemoryExecutor): Promise<{ current_version: number; applied_versions: number[] }> {
  return executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [0x52414756]);
    await tx.query("CREATE TABLE IF NOT EXISTS ragsystem_vector_index_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const applied = await tx.query<{ version: number | string; name: string }>("SELECT version,name FROM ragsystem_vector_index_schema_migrations ORDER BY version");
    for (let i = 0; i < applied.rows.length; i += 1) {
      const expected = POSTGRES_VECTOR_INDEX_MIGRATIONS[i];
      if (!expected || Number(applied.rows[i]?.version) !== expected.version || applied.rows[i]?.name !== expected.name) throw new Error("invalid PostgreSQL vector index migration history");
    }
    const pending = POSTGRES_VECTOR_INDEX_MIGRATIONS.slice(applied.rows.length);
    for (const migration of pending) {
      await tx.query(migration.sql);
      await tx.query("INSERT INTO ragsystem_vector_index_schema_migrations(version,name) VALUES($1,$2)", [migration.version, migration.name]);
    }
    return { current_version: POSTGRES_VECTOR_INDEX_MIGRATIONS.length, applied_versions: pending.map((migration) => migration.version) };
  });
}
