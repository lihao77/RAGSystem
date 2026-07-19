import { describe, expect, it } from "vitest";
import { PostgresRunRepository } from "../../../../src/adapters/saas/postgres/run-repository.js";
import { POSTGRES_RUN_MIGRATIONS } from "../../../../src/adapters/saas/postgres/run-schema.js";

describe("PostgresRunRepository tenant isolation", () => {
  it("uses tenant-scoped run keys, step keys, and foreign keys", () => {
    const sql = POSTGRES_RUN_MIGRATIONS[0]?.sql ?? "";
    expect(sql).toContain("PRIMARY KEY (tenant_id, run_id)");
    expect(sql).toContain("UNIQUE(tenant_id, session_id, run_id, step_order)");
    expect(sql).toContain("FOREIGN KEY (tenant_id, run_id)");
    expect(sql).toContain("ON saas_run_steps(tenant_id, session_id, message_id)");
    expect(POSTGRES_RUN_MIGRATIONS[1]).toMatchObject({ version: 2, name: "tenant-scoped-run-state-rebuild" });
    expect(POSTGRES_RUN_MIGRATIONS[1]?.sql).toContain("DROP TABLE IF EXISTS saas_runs");
  });

  it("includes tenant_id in every run and step operation", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const row = {
      run_id: "r1", session_id: "s1", tenant_id: "tenant-a", status: "running", thread_key: "root",
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    };
    const query = async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("COUNT(*)")) return { rows: [{ count: "1" }], rowCount: 1 };
      if (sql.includes("MAX(step_order)")) return { rows: [{ next_order: 1 }], rowCount: 1 };
      if (sql.includes("INSERT INTO saas_run_steps")) return { rows: [{ id: 1 }], rowCount: 1 };
      if (sql.startsWith("SELECT id, run_id")) return { rows: [{ id: 1, run_id: "r1", session_id: "s1", message_id: null, step_order: 1, step_type: "event", payload: {}, created_at: "2026-01-01T00:00:00Z" }], rowCount: 1 };
      if (sql.includes("RETURNING") || sql.startsWith("SELECT")) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    const executor = { query, transaction: async <T>(operation: (tx: { query: typeof query }) => Promise<T>) => operation({ query }) };
    const repo = new PostgresRunRepository(executor);

    await repo.createRun({ tenantId: "tenant-a", runId: "r1", sessionId: "s1" });
    await repo.updateRunStatus("tenant-a", "r1", "s1", "completed");
    await repo.getRun("tenant-a", "s1", "r1");
    await repo.listRuns("tenant-a", "s1");
    await repo.interruptSuspendedRuns("tenant-a", "s1");
    await repo.addRunStep({ tenantId: "tenant-a", runId: "r1", sessionId: "s1", stepType: "event", payload: {} });
    await repo.updateRunStepsMessageId("tenant-a", "s1", "r1", "m1");
    await repo.listRunSteps({ tenantId: "tenant-a", sessionId: "s1", runId: "r1" });

    expect(calls.filter((call) => /saas_runs|saas_run_steps/.test(call.sql)).every((call) =>
      call.sql.includes("tenant_id") && call.params.includes("tenant-a"))).toBe(true);
  });
});
