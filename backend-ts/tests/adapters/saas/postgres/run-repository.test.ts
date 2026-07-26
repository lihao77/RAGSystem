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
    expect(POSTGRES_RUN_MIGRATIONS[2]).toMatchObject({ version: 3, name: "remove-duplicate-saas-boundary-messages" });
    expect(POSTGRES_RUN_MIGRATIONS[2]?.sql).toContain("SET final_message_id = canonical.id");
    expect(POSTGRES_RUN_MIGRATIONS[2]?.sql).toContain("DELETE FROM conversation_messages AS boundary");
    expect(POSTGRES_RUN_MIGRATIONS[3]).toMatchObject({ version: 4, name: "run-step-event-idempotency" });
    expect(POSTGRES_RUN_MIGRATIONS[3]?.sql).toContain("ADD COLUMN IF NOT EXISTS event_id TEXT");
    expect(POSTGRES_RUN_MIGRATIONS[3]?.sql).toContain("ON saas_run_steps(tenant_id, event_id)");
    expect(POSTGRES_RUN_MIGRATIONS[4]).toMatchObject({ version: 5, name: "root-run-owner-lease" });
    expect(POSTGRES_RUN_MIGRATIONS[4]?.sql).toContain("owner_instance_id");
    expect(POSTGRES_RUN_MIGRATIONS[4]?.sql).toContain("lease_expires_at");
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
      if (sql.includes("FROM saas_runs") && sql.includes("FOR UPDATE")) return { rows: [{ run_id: "r1" }], rowCount: 1 };
      if (sql.includes("MAX(step_order)")) return { rows: [{ next_order: 1 }], rowCount: 1 };
      if (sql.includes("INSERT INTO saas_run_steps")) return { rows: [{
        id: 1,
        run_id: String(params[1]),
        session_id: String(params[2]),
        event_id: params[4] ?? null,
        step_order: Number(params[5]),
        step_type: String(params[6]),
      }], rowCount: 1 };
      if (sql.startsWith("SELECT id, run_id")) return { rows: [{ id: 1, run_id: "r1", session_id: "s1", message_id: null, step_order: 1, step_type: "event", payload: {}, created_at: "2026-01-01T00:00:00Z" }], rowCount: 1 };
      if (sql.includes("RETURNING") || sql.startsWith("SELECT")) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    const executor = { query, transaction: async <T>(operation: (tx: { query: typeof query }) => Promise<T>) => operation({ query }) };
    const repo = new PostgresRunRepository(executor as never);

    await repo.createRun({ tenantId: "tenant-a", runId: "r1", sessionId: "s1" });
    await repo.updateRunStatus("tenant-a", "r1", "s1", "completed");
    await repo.getRun("tenant-a", "s1", "r1");
    await repo.listRuns("tenant-a", "s1");
    await repo.interruptSuspendedRuns("tenant-a", "s1");
    await repo.addRunStep({ tenantId: "tenant-a", runId: "r1", sessionId: "s1", stepType: "event", payload: {} });
    await repo.updateRunStepsMessageId("tenant-a", "s1", "r1", "m1");
    await repo.listRunSteps({ tenantId: "tenant-a", sessionId: "s1", runId: "r1" });
    await repo.getTenantRun("tenant-a", "r1");
    await repo.listTenantRuns("tenant-a", true);

    expect(calls.filter((call) => /saas_runs|saas_run_steps/.test(call.sql)).every((call) =>
      call.sql.includes("tenant_id") && call.params.includes("tenant-a"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("status='running'") && call.params[0] === "tenant-a")).toBe(true);
  });

  it("serializes step ordering by locking the tenant-scoped run before reading MAX(step_order)", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const query = async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("FROM saas_runs")) return { rows: [{ run_id: "run-1" }], rowCount: 1 };
      if (sql.includes("MAX(step_order)")) return { rows: [{ next_order: "4" }], rowCount: 1 };
      if (sql.includes("INSERT INTO saas_run_steps")) return { rows: [{
        id: "9",
        run_id: String(params[1]),
        session_id: String(params[2]),
        event_id: params[4] ?? null,
        step_order: String(params[5]),
        step_type: String(params[6]),
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const executor = {
      query,
      transaction: async <T>(operation: (tx: { query: typeof query }) => Promise<T>) => operation({ query }),
    };
    const repo = new PostgresRunRepository(executor as never);

    await expect(repo.addRunStep({
      tenantId: "tenant-a",
      sessionId: "session-1",
      runId: "run-1",
      stepType: "protocol.envelope.v1",
      payload: { type: "run_started" },
    })).resolves.toEqual({
      id: 9,
      run_id: "run-1",
      event_id: null,
      step_order: 4,
      step_type: "protocol.envelope.v1",
    });

    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({
      sql: "SELECT run_id FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 FOR UPDATE",
      params: ["tenant-a", "session-1", "run-1"],
    });
    expect(calls[1]?.sql).toContain("MAX(step_order)");
    expect(calls[1]?.sql).not.toContain("FOR UPDATE");
    expect(calls[1]?.params).toEqual(["tenant-a", "session-1", "run-1"]);
    expect(calls[2]?.sql).toContain("INSERT INTO saas_run_steps");
    expect(calls[2]?.params.slice(0, 3)).toEqual(["tenant-a", "run-1", "session-1"]);
  });

  it("returns the original step for the same eventId and rejects reuse by another run", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    let persisted: Record<string, unknown> | null = null;
    const query = async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("FROM saas_runs") && sql.includes("FOR UPDATE")) {
        return { rows: [{ run_id: String(params[2]) }], rowCount: 1 };
      }
      if (sql.includes("WHERE tenant_id=$1 AND event_id=$2")) {
        return { rows: persisted ? [persisted] : [], rowCount: persisted ? 1 : 0 };
      }
      if (sql.includes("MAX(step_order)")) return { rows: [{ next_order: "1" }], rowCount: 1 };
      if (sql.includes("INSERT INTO saas_run_steps")) {
        persisted = {
          id: "11",
          run_id: String(params[1]),
          session_id: String(params[2]),
          event_id: String(params[4]),
          step_order: String(params[5]),
          step_type: String(params[6]),
        };
        return { rows: [persisted], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    };
    const executor = {
      query,
      transaction: async <T>(operation: (tx: { query: typeof query }) => Promise<T>) => operation({ query }),
    };
    const repo = new PostgresRunRepository(executor as never);
    const input = {
      tenantId: "tenant-a",
      sessionId: "session-1",
      runId: "run-1",
      eventId: "event-1",
      stepType: "protocol.envelope.v1",
      payload: { type: "tool_call" },
    };

    const first = await repo.addRunStep(input);
    const retried = await repo.addRunStep({ ...input, payload: { ignored: true } });

    expect(retried).toEqual(first);
    expect(first).toEqual({
      id: 11,
      run_id: "run-1",
      event_id: "event-1",
      step_order: 1,
      step_type: "protocol.envelope.v1",
    });
    expect(calls.filter(({ sql }) => sql.includes("INSERT INTO saas_run_steps"))).toHaveLength(1);
    expect(calls.filter(({ sql }) => sql.includes("MAX(step_order)"))).toHaveLength(1);

    await expect(repo.addRunStep({ ...input, runId: "run-2" }))
      .rejects.toThrow("run step eventId is already owned by another run: event-1");
  });

  it("rejects a step for a missing tenant-scoped run before allocating an order", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const query = async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    };
    const executor = {
      query,
      transaction: async <T>(operation: (tx: { query: typeof query }) => Promise<T>) => operation({ query }),
    };
    const repo = new PostgresRunRepository(executor as never);

    await expect(repo.addRunStep({
      tenantId: "tenant-a",
      sessionId: "session-1",
      runId: "missing-run",
      stepType: "event",
      payload: {},
    })).rejects.toThrow("run not found: missing-run");

    expect(calls).toEqual([{
      sql: "SELECT run_id FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 FOR UPDATE",
      params: ["tenant-a", "session-1", "missing-run"],
    }]);
  });
});
