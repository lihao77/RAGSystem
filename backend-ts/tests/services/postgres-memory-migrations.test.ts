import { describe, expect, it } from "vitest";

import { runPostgresMemoryMigrations } from "../../src/adapters/saas/postgres/memory-migrations.js";
import type { PostgresMemoryExecutor, PostgresQueryResult } from "../../src/adapters/saas/postgres/memory-repository.js";

class MigrationExecutor implements PostgresMemoryExecutor {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  transactions = 0;

  constructor(private readonly history: Record<string, unknown>[] = []) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, ...(params == null ? {} : { params }) });
    if (sql.startsWith("SELECT version, name")) return { rows: this.history as Row[] };
    return { rows: [] };
  }

  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn(this);
  }
}

describe("PostgreSQL memory migration runner", () => {
  it("locks, creates the version table, and applies pending migrations in order", async () => {
    const executor = new MigrationExecutor([
      { version: 1, name: "memory-entries" },
    ]);

    await expect(runPostgresMemoryMigrations(executor)).resolves.toEqual({
      previous_version: 1,
      current_version: 4,
      applied_versions: [2, 3, 4],
    });
    expect(executor.transactions).toBe(1);
    expect(executor.calls[0]?.sql).toBe("SELECT pg_advisory_xact_lock($1)");
    expect(executor.calls[1]?.sql).toContain("ragsystem_memory_schema_migrations");
    const inserts = executor.calls.filter((call) => call.sql.startsWith("INSERT INTO ragsystem_memory_schema_migrations"));
    expect(inserts.map((call) => call.params)).toEqual([
      [2, "memory-candidates"],
      [3, "memory-candidate-review-claims"],
      [4, "publish-existing-personal-memory-candidates"],
    ]);
  });

  it("does not re-run an up-to-date schema", async () => {
    const executor = new MigrationExecutor([
      { version: 1, name: "memory-entries" },
      { version: 2, name: "memory-candidates" },
      { version: 3, name: "memory-candidate-review-claims" },
      { version: 4, name: "publish-existing-personal-memory-candidates" },
    ]);

    const migrated = await runPostgresMemoryMigrations(executor);
    expect(migrated.applied_versions).toEqual([]);
    expect(executor.calls.some((call) => call.sql.startsWith("INSERT INTO ragsystem_memory_schema_migrations"))).toBe(false);
  });

  it("rejects a divergent migration history before running DDL", async () => {
    const executor = new MigrationExecutor([{ version: 1, name: "renamed-migration" }]);
    await expect(runPostgresMemoryMigrations(executor)).rejects.toThrow("invalid PostgreSQL memory migration history");
    expect(executor.calls).toHaveLength(3);
  });
});
