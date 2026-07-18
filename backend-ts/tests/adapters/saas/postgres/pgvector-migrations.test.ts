import { describe, expect, it } from "vitest";
import { runPostgresPgVectorMigrations } from "../../../../src/adapters/saas/postgres/pgvector-migrations.js";
import type { PostgresMemoryExecutor, PostgresQueryResult } from "../../../../src/adapters/saas/postgres/memory-repository.js";

class MigrationExecutor implements PostgresMemoryExecutor {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  constructor(private readonly history: Record<string, unknown>[] = []) {}
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, ...(params == null ? {} : { params }) });
    if (sql.startsWith("SELECT version,name")) return { rows: this.history as Row[] };
    return { rows: [], rowCount: 0 };
  }
  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> { return fn(this); }
}

describe("PostgreSQL pgvector migration runner", () => {
  it("locks and applies the pgvector schema", async () => {
    const executor = new MigrationExecutor();
    await expect(runPostgresPgVectorMigrations(executor)).resolves.toEqual({ current_version: 1, applied_versions: [1] });
    expect(executor.calls[0]?.sql).toBe("SELECT pg_advisory_xact_lock($1)");
    expect(executor.calls.some((call) => call.sql.includes("CREATE EXTENSION IF NOT EXISTS vector"))).toBe(true);
    expect(executor.calls.some((call) => call.sql.startsWith("INSERT INTO ragsystem_pgvector_schema_migrations"))).toBe(true);
  });

  it("does not rerun an up-to-date schema", async () => {
    const executor = new MigrationExecutor([{ version: 1, name: "knowledge_vector_chunks_pgvector" }]);
    await expect(runPostgresPgVectorMigrations(executor)).resolves.toEqual({ current_version: 1, applied_versions: [] });
    expect(executor.calls.some((call) => call.sql.startsWith("INSERT INTO ragsystem_pgvector_schema_migrations"))).toBe(false);
  });
});
