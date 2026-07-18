import { describe, expect, it, vi } from "vitest";
import { PostgresOutboxRepository } from "../../../../src/adapters/saas/postgres/outbox-repository.js";
import type { PostgresMemoryExecutor, PostgresQueryResult } from "../../../../src/adapters/saas/postgres/memory-repository.js";

const base = { id: 1, event_id: "evt-1", session_id: "s1", tenant_id: "t1", run_id: null, session_seq: 1, event_type: "client.delta", aggregate_type: "session", aggregate_id: "s1", payload: { text: "ok" }, status: "pending", attempts: 0, available_at: "2026-01-01T00:00:00Z", locked_at: null, delivered_at: null, last_error: null, created_at: "2026-01-01T00:00:00Z" };

class FakeExecutor implements PostgresMemoryExecutor {
  calls: string[] = [];
  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, _params?: readonly unknown[]): Promise<PostgresQueryResult<T>> {
    this.calls.push(sql);
    if (sql.includes("SELECT tenant_id")) return { rows: [{ tenant_id: "t1" } as T] };
    if (sql.includes("next_seq")) return { rows: [{ seq: 1 } as T] };
    if (sql.includes("RETURNING id,event_id")) return { rows: [base as T] };
    if (sql.includes("UPDATE event_outbox")) return { rows: [], rowCount: 1 };
    return { rows: [] };
  }
  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> { return fn(this); }
}

describe("PostgresOutboxRepository", () => {
  it("scopes durable replay by tenant, session and sequence cursor", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new PostgresOutboxRepository({ query } as never);

    await repository.listOutboxForReplay({ tenantId: "tenant-a", sessionId: "s1", afterSeq: 4, limit: 20 });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("tenant_id=$1 AND session_id=$2"),
      ["tenant-a", "s1", 4, 20],
    );
    expect(query.mock.calls[0]?.[0]).toContain("session_seq>$3");
  });

  it("allocates a per-session sequence and appends JSON payload", async () => {
    const db = new FakeExecutor();
    const result = await new PostgresOutboxRepository(db).appendOutbox({ sessionId: "s1", eventId: "evt-1", eventType: "client.delta", aggregateType: "session", aggregateId: "s1", payload: { text: "ok" } });
    expect(result.session_seq).toBe(1);
    expect(result.payload).toBe('{"text":"ok"}');
    expect(db.calls.some((sql) => sql.includes("ON CONFLICT(session_id,session_seq) DO NOTHING"))).toBe(true);
  });

  it("claims with row locking and exposes delivery state transitions", async () => {
    const db = new FakeExecutor();
    const repo = new PostgresOutboxRepository(db);
    const claimed = await repo.claimPendingOutbox({ limit: 2 });
    expect(claimed).toHaveLength(1);
    expect(db.calls.some((sql) => sql.includes("FOR UPDATE SKIP LOCKED"))).toBe(true);
    await expect(repo.markOutboxDelivered(1)).resolves.toBe(true);
    await expect(repo.markOutboxRetrying(1, "temporary", "2026-01-01T00:00:00Z")).resolves.toBe(true);
    await expect(repo.markOutboxFailed(1, "fatal")).resolves.toBe(true);
  });
});
