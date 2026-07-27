import { describe, expect, it } from "vitest";

import { runPostgresGoalMigrations } from "../../src/adapters/saas/postgres/goal-migrations.js";
import { PostgresGoalRepository } from "../../src/adapters/saas/postgres/goal-repository.js";
import type { PostgresMemoryExecutor, PostgresQueryResult } from "../../src/adapters/saas/postgres/memory-repository.js";
import { createTenantId } from "../../src/identity/types.js";

class GoalExecutor implements PostgresMemoryExecutor {
  readonly calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  transactions = 0;
  row: Record<string, unknown> | null = null;

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, ...(params ? { params } : {}) });
    if (sql.includes("SELECT version,name FROM ragsystem_goal_schema_migrations")) return { rows: [] };
    if (sql.includes("INSERT INTO workflow_goals")) {
      this.row = {
        goal_id: String(params?.[1]), session_id: String(params?.[2]), objective: String(params?.[3]),
        success_criteria: JSON.parse(String(params?.[4])), steps: JSON.parse(String(params?.[5])),
        checkpoint: JSON.parse(String(params?.[6])), progress: JSON.parse(String(params?.[7])), status: "active",
        continuation_count: 0, no_progress_count: 0, continuation_generation: 0,
        continuation_pending: false, continuation_claimed_at: null, last_progress_fingerprint: null,
        created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      };
      return { rows: [structuredClone(this.row) as Row], rowCount: 1 };
    }
    if (sql.includes("status='active'") && sql.includes("FOR UPDATE")) {
      return { rows: this.row?.status === "active" ? [structuredClone(this.row) as Row] : [] };
    }
    if (sql.includes("continuation_count=continuation_count+1")) {
      if (!this.row) return { rows: [] };
      this.row = { ...this.row, continuation_count: 1, no_progress_count: params?.[0], continuation_generation: 1,
        continuation_pending: true, continuation_claimed_at: "2026-01-01T00:01:00.000Z", last_progress_fingerprint: params?.[1] };
      return { rows: [structuredClone(this.row) as Row], rowCount: 1 };
    }
    if (sql.includes("continuation_pending=FALSE") && sql.includes("continuation_generation=$4")) {
      if (this.row) this.row = { ...this.row, continuation_pending: false, continuation_claimed_at: null };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("status IN ('active', 'paused')")) return { rows: this.row ? [structuredClone(this.row) as Row] : [] };
    if (sql.includes("goal_id=$3::uuid")) return { rows: this.row ? [structuredClone(this.row) as Row] : [] };
    if (sql.includes("ORDER BY created_at DESC")) return { rows: this.row ? [structuredClone(this.row) as Row] : [] };
    return { rows: [], rowCount: 0 };
  }

  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn(this);
  }
}

describe("PostgreSQL Goal persistence", () => {
  it("migrates a tenant/session-scoped Goal table with one-current invariant", async () => {
    const executor = new GoalExecutor();
    await expect(runPostgresGoalMigrations(executor)).resolves.toEqual({ current_version: 2, applied_versions: [1, 2] });
    const ddl = executor.calls.find((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS workflow_goals"))?.sql ?? "";
    expect(ddl).toContain("PRIMARY KEY (tenant_id, goal_id)");
    expect(ddl).toContain("FOREIGN KEY (tenant_id, session_id)");
    expect(ddl).toContain("WHERE status IN ('active', 'paused')");
  });

  it("binds Goal CRUD and atomic continuation claims to tenant/session", async () => {
    const executor = new GoalExecutor();
    const repository = new PostgresGoalRepository(createTenantId("tnt_goal_pg"), executor);
    const goal = await repository.create("session-a", {
      objective: "Ship",
      successCriteria: ["verified"],
      steps: [{ id: "1", title: "Build", description: "Implement", status: "pending", evidence: null }],
    });
    expect(goal).toMatchObject({ session_id: "session-a", objective: "Ship", status: "active" });
    await expect(repository.getCurrent("session-a")).resolves.toMatchObject({ id: goal.id });
    await expect(repository.claimContinuation("session-a")).resolves.toMatchObject({
      continuation_count: 1, continuation_generation: 1, continuation_pending: true,
    });
    await expect(repository.releaseContinuation("session-a", goal.id, 1)).resolves.toBe(true);
    expect(executor.calls.some((call) => call.sql.includes("FOR UPDATE"))).toBe(true);
    expect(executor.calls.filter((call) => call.params?.[0] === "tnt_goal_pg").length).toBeGreaterThan(1);
  });
});
