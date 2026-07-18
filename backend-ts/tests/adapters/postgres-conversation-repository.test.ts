import { describe, expect, it } from "vitest";
import { POSTGRES_CONVERSATION_MIGRATIONS } from "../../src/adapters/saas/postgres/conversation-schema.js";
import { PostgresConversationRepository } from "../../src/adapters/saas/postgres/conversation-repository.js";
import type { PostgresMemoryExecutor, PostgresQueryResult } from "../../src/adapters/saas/postgres/memory-repository.js";
import { createTenantId } from "../../src/identity/types.js";

class FakeExecutor implements PostgresMemoryExecutor {
  readonly calls: string[] = [];
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, _params: readonly unknown[] = []): Promise<PostgresQueryResult<Row>> {
    this.calls.push(sql);
    if (sql.startsWith("INSERT INTO conversation_messages")) return { rows: [{ seq: 1, id: "m1", session_id: "s1", role: "user", content: "hello", metadata: {}, thread_key: "root", child_agent_id: null, created_at: "2026-01-01T00:00:00Z" }] as Row[] };
    if (sql.startsWith("SELECT * FROM conversation_messages")) return { rows: [{ seq: 1, id: "m1", session_id: "s1", role: "user", content: "hello", metadata: {}, thread_key: "root", child_agent_id: null, created_at: "2026-01-01T00:00:00Z" }] as Row[] };
    if (sql.startsWith("SELECT metadata FROM conversation_sessions")) return { rows: [{ metadata: { cache: { child: 1 } } }] as Row[] };
    if (sql.startsWith("UPDATE conversation_sessions SET metadata=")) return { rows: [{ metadata: JSON.parse(String(_params[0])) }] as Row[], rowCount: 1 };
    if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ total: "1" }] as Row[] };
    return { rows: [], rowCount: 1 } as PostgresQueryResult<Row>;
  }
  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> { return fn(this); }
}

describe("PostgreSQL conversation slice", () => {
  it("defines tenant-scoped session/message schema", () => {
    expect(POSTGRES_CONVERSATION_MIGRATIONS).toHaveLength(2);
    expect(POSTGRES_CONVERSATION_MIGRATIONS[0]?.sql).toContain("conversation_sessions");
    expect(POSTGRES_CONVERSATION_MIGRATIONS[0]?.sql).toContain("tenant_id TEXT NOT NULL");
    expect(POSTGRES_CONVERSATION_MIGRATIONS[0]?.sql).toContain("conversation_messages");
  });

  it("writes and reads messages through the async port", async () => {
    const executor = new FakeExecutor();
    const repository = new PostgresConversationRepository(executor);
    const created = await repository.addMessage({ sessionId: "s1", role: "user", content: "hello" });
    expect(created).toMatchObject({ id: "m1", session_id: "s1", content: "hello" });
    const recent = await repository.getRecentMessages("s1");
    expect(recent).toHaveLength(1);
    expect(executor.calls.some((sql) => sql.includes("conversation_messages"))).toBe(true);
  });

  it("deep-merges session metadata like the Local store", async () => {
    const repository = new PostgresConversationRepository(new FakeExecutor());
    await expect(repository.updateSessionMetadata("s1", { cache: { root: 2 } })).resolves.toEqual({
      cache: { child: 1, root: 2 },
    });
  });

  it("rejects a session id already owned by another tenant", async () => {
    const repository = new PostgresConversationRepository(new FakeExecutor());
    await expect(repository.createSession(createTenantId("tnt_b"), "shared-session", "user-b"))
      .rejects.toThrow("session id is already owned by another tenant");
  });
});
