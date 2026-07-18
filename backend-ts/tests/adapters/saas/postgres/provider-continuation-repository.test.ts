import { describe, expect, it } from "vitest";

import { POSTGRES_CONVERSATION_MIGRATIONS } from "../../../../src/adapters/saas/postgres/conversation-schema.js";
import { PostgresProviderContinuationRepository } from "../../../../src/adapters/saas/postgres/provider-continuation-repository.js";
import type { PostgresMemoryExecutor, PostgresQueryResult } from "../../../../src/adapters/saas/postgres/memory-repository.js";

const continuation = {
  protocol: "anthropic_messages" as const,
  toolCallIds: ["tool-1"],
  blocks: [{ type: "thinking" as const, thinking: "private", signature: "sig" }],
};

class FakeExecutor implements PostgresMemoryExecutor {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<Row>> {
    this.calls.push({ sql, params });
    if (sql.startsWith("INSERT")) {
      return { rows: [{
        message_id: params[1], session_id: params[2], thread_key: params[3], provider_type: params[4],
        tool_call_ids: JSON.parse(String(params[5])), state: JSON.parse(String(params[6])),
        created_at: "2026-01-01T00:00:00Z",
      }] as Row[], rowCount: 1 };
    }
    if (sql.startsWith("SELECT")) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 2 };
  }

  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> { return fn(this); }
}

describe("Postgres provider continuation repository", () => {
  it("defines tenant- and session-scoped continuation storage", () => {
    const migration = POSTGRES_CONVERSATION_MIGRATIONS[1];
    expect(migration?.name).toBe("provider_continuations");
    expect(migration?.sql).toContain("PRIMARY KEY (tenant_id, message_id)");
    expect(migration?.sql).toContain("FOREIGN KEY (tenant_id, session_id)");
    expect(migration?.sql).toContain("FOREIGN KEY (session_id, message_id)");
  });

  it("puts, gets, and deletes within the tenant/session boundary", async () => {
    const executor = new FakeExecutor();
    const repository = new PostgresProviderContinuationRepository(executor);
    const record = await repository.putProviderContinuation("t1", {
      messageId: "m1", sessionId: "s1", threadKey: "root", providerType: "anthropic",
      toolCallIds: ["tool-1"], state: continuation,
    });
    expect(record).toMatchObject({ message_id: "m1", session_id: "s1", state: continuation });

    expect(await repository.getProviderContinuation("t2", "s1", "m1")).toBeNull();
    expect(await repository.deleteProviderContinuations("t1", "s1", "root")).toBe(2);
    expect(executor.calls[1]?.params).toEqual(["t2", "s1", "m1"]);
    expect(executor.calls[2]?.params).toEqual(["t1", "s1", "root"]);
  });
});
