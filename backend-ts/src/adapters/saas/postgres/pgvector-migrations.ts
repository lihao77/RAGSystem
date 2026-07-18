import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { POSTGRES_PGVECTOR_MIGRATIONS } from "./pgvector-schema.js";
export async function runPostgresPgVectorMigrations(executor: PostgresMemoryExecutor): Promise<{ current_version: number; applied_versions: number[] }> {
  try { return await executor.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [0x52414750]);
    await tx.query("CREATE TABLE IF NOT EXISTS ragsystem_pgvector_schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const applied = await tx.query<{ version: number | string; name: string }>("SELECT version,name FROM ragsystem_pgvector_schema_migrations ORDER BY version");
    for (let i = 0; i < applied.rows.length; i += 1) { const expected = POSTGRES_PGVECTOR_MIGRATIONS[i]; if (!expected || Number(applied.rows[i]?.version) !== expected.version || applied.rows[i]?.name !== expected.name) throw new Error("invalid PostgreSQL pgvector migration history"); }
    const pending = POSTGRES_PGVECTOR_MIGRATIONS.slice(applied.rows.length);
    for (const migration of pending) { await tx.query(migration.sql); await tx.query("INSERT INTO ragsystem_pgvector_schema_migrations(version,name) VALUES($1,$2)", [migration.version, migration.name]); }
    return { current_version: POSTGRES_PGVECTOR_MIGRATIONS.length, applied_versions: pending.map((migration) => migration.version) };
  }); } catch (error) { const message = error instanceof Error ? error.message : String(error); if (/extension|vector|type.*vector|gen_random_uuid/i.test(message)) throw new Error(`PostgreSQL pgvector is required for SaaS knowledge search. Install the vector extension (for example use pgvector/pgvector:pg17) and retry: ${message}`); throw error; }
}
