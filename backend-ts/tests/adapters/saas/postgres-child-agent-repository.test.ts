import { describe, expect, it } from "vitest";
import { POSTGRES_CHILD_AGENT_MIGRATIONS } from "../../../src/adapters/saas/postgres/child-agent-schema.js";
import { runPostgresChildAgentMigrations } from "../../../src/adapters/saas/postgres/child-agent-migrations.js";
import { PostgresChildAgentRepository } from "../../../src/adapters/saas/postgres/child-agent-repository.js";
import { TenantBoundPostgresAgentDelegationStore } from "../../../src/adapters/saas/postgres/tenant-agent-delegation-store.js";
import type { PostgresMemoryExecutor, PostgresQueryResult } from "../../../src/adapters/saas/postgres/memory-repository.js";
import { PostgresConversationRepository } from "../../../src/adapters/saas/postgres/conversation-repository.js";
import { PostgresRunRepository } from "../../../src/adapters/saas/postgres/run-repository.js";

const childRow = {
  child_agent_id: "child-1", session_id: "session-1", agent_name: "worker",
  thread_key: "child:child-1", status: "active", created_seq: null,
  created_by_run_id: "run-1", created_by_call_id: "call-1", parent_run_id: "run-1",
  parent_call_id: "call-1", last_run_id: null, metadata: { source: "test" },
  created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
};

class FakeExecutor implements PostgresMemoryExecutor {
  calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });
    if (sql.includes("SELECT 1 FROM conversation_sessions")) return { rows: [{ ok: 1 }] as unknown as Row[] };
    if (sql.startsWith("INSERT INTO saas_child_agents")) return { rows: [childRow] as unknown as Row[], rowCount: 1 };
    if (sql.startsWith("SELECT COUNT(*)::text AS cnt")) return { rows: [{ cnt: "1" }] as unknown as Row[] };
    if (sql.startsWith("SELECT child_agent_id") && sql.includes("created_by_run_id")) return { rows: [childRow] as unknown as Row[] };
    if (sql.startsWith("SELECT child_agent_id") && sql.includes("child_agent_id=$3")) return { rows: [childRow] as unknown as Row[] };
    if (sql.startsWith("SELECT child_agent_id")) return { rows: [childRow] as unknown as Row[] };
    if (sql.startsWith("INSERT INTO conversation_messages")) return { rows: [{ seq: 1, id: "m1", session_id: "session-1", role: "user", content: "task", metadata: {}, thread_key: "child:child-1", child_agent_id: "child-1", created_at: "2026-01-01T00:00:00.000Z" }] as unknown as Row[] };
    if (sql.startsWith("SELECT * FROM conversation_messages")) return { rows: [] as Row[] };
    if (sql.startsWith("UPDATE saas_child_agents")) return { rows: [] as Row[], rowCount: 1 };
    if (sql.startsWith("UPDATE conversation_sessions")) return { rows: [] as Row[], rowCount: 1 };
    if (sql.startsWith("UPDATE saas_runs")) return { rows: [] as Row[], rowCount: 1 };
    if (sql.includes("FROM saas_runs")) return { rows: [] as Row[] };
    return { rows: [] as Row[], rowCount: 1 };
  }
  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> { return fn(this); }
}

describe("SaaS child-agent PostgreSQL persistence", () => {
  it("defines tenant-scoped schema and creator lookup", () => {
    const sql = POSTGRES_CHILD_AGENT_MIGRATIONS[0]!.sql;
    expect(sql).toContain("PRIMARY KEY (tenant_id, child_agent_id)");
    expect(sql).toContain("REFERENCES conversation_sessions(tenant_id, session_id)");
    expect(sql).toContain("REFERENCES saas_runs(tenant_id, run_id)");
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS saas_child_agents_creator_idx");
    expect(sql).not.toContain("FOREIGN KEY (tenant_id, last_run_id)");
  });

  it("runs child-agent migration independently after conversation and run schema", async () => {
    const executor = new FakeExecutor();
    await expect(runPostgresChildAgentMigrations(executor)).resolves.toMatchObject({
      current_version: 1,
      applied_versions: [1],
    });
    expect(executor.calls.some(({ sql }) => sql.includes("ragsystem_child_agent_schema_migrations"))).toBe(true);
    expect(executor.calls.some(({ sql }) => sql.includes("CREATE TABLE IF NOT EXISTS saas_child_agents"))).toBe(true);
  });

  it("persists and reads the child aggregate with tenant parameters", async () => {
    const executor = new FakeExecutor();
    const repository = new PostgresChildAgentRepository(executor);
    const created = await repository.createChildAgent("tenant-a", {
      childAgentId: "child-1", sessionId: "session-1", agentName: "worker",
      createdByRunId: "run-1", createdByCallId: "call-1", parentRunId: "run-1", parentCallId: "call-1",
      metadata: { source: "test" },
    });
    expect(created).toMatchObject({ child_agent_id: "child-1", agent_name: "worker" });
    const listed = await repository.listChildAgents("tenant-a", { sessionId: "session-1" });
    expect(listed.total).toBe(1);
    expect(executor.calls.every(({ sql, params }) => !sql.includes("saas_child_agents") || params[0] === "tenant-a")).toBe(true);
  });

  it("routes the shared delegation port to tenant-bound async repositories", async () => {
    const executor = new FakeExecutor();
    const store = new TenantBoundPostgresAgentDelegationStore(
      "tenant-a" as never,
      executor,
      new PostgresConversationRepository(executor),
      new PostgresRunRepository(executor),
    );
    await store.addMessage({ sessionId: "session-1", role: "user", content: "task", threadKey: "child:child-1", childAgentId: "child-1" });
    await store.updateChildAgentLastRun({ sessionId: "session-1", childAgentId: "child-1", lastRunId: "run-2" });
    expect(executor.calls.some(({ sql, params }) => sql.includes("saas_child_agents") && params[1] === "tenant-a")).toBe(true);
    expect(executor.calls.some(({ sql, params }) => sql.includes("conversation_messages") && params.includes("session-1"))).toBe(true);
  });
});
