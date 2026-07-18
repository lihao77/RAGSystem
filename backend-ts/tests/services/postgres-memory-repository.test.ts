import { describe, expect, it } from "vitest";

import { PostgresMemoryRepository, type PostgresMemoryExecutor, type PostgresQueryResult } from "../../src/adapters/saas/postgres/memory-repository.js";

const dates = { created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", reviewed_at: null, archived_at: null };
const candidateRow = { ...dates, tenant_id: "t1", id: "c1", owner_user_id: "u1", scope: "team", scope_id: "team-1", operation: "publish", target_memory_id: null, name: "n", description: "d", memory_type: "fact", content: "c", why: null, how_to_apply: null, status: "candidate", reviewer_user_id: null, review_comment: null, published_memory_id: null, version: 1, source_session_id: null, source_run_id: null, source_message_id: null };
const memoryRow = { ...dates, tenant_id: "t1", id: "m1", scope: "team", scope_id: "team-1", name: "n", description: "d", memory_type: "fact", content: "c", why: null, how_to_apply: null, status: "active", source_run_id: null, source_message_id: null, version: 1 };

class FakeExecutor implements PostgresMemoryExecutor {
  readonly calls: string[] = [];
  transactions = 0;
  async query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, _params?: readonly unknown[]): Promise<PostgresQueryResult<Row>> {
    this.calls.push(sql);
    if (sql.startsWith("INSERT INTO memory_candidates")) return { rows: [candidateRow as unknown as Row] };
    if (sql.includes("FROM memory_candidates") && sql.includes("FOR UPDATE")) return { rows: [candidateRow as unknown as Row] };
    if (sql.startsWith("INSERT INTO memory_entries")) return { rows: [memoryRow as unknown as Row] };
    if (sql.startsWith("UPDATE memory_candidates")) return { rows: [{ ...candidateRow, status: "approved", version: 2, published_memory_id: "m1", reviewer_user_id: "admin" } as unknown as Row] };
    if (sql.startsWith("INSERT INTO memory_scope_revisions")) return { rows: [{ revision: 1 } as unknown as Row] };
    return { rows: [] };
  }
  async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn(this);
  }
}

describe("PostgresMemoryRepository", () => {
  it("uses tenant-scoped parameterized queries", async () => {
    const executor = new FakeExecutor();
    const repository = new PostgresMemoryRepository(executor);
    await repository.getEntry("tenant-a", "memory-1");
    expect(executor.calls[0]).toContain("tenant_id = $1");
  });

  it("creates candidates and approves publish atomically", async () => {
    const executor = new FakeExecutor();
    const repository = new PostgresMemoryRepository(executor);
    const created = await repository.createCandidate({ tenant_id: "t1", scope: "team", scope_id: "team-1", operation: "publish", owner_user_id: "u1", name: "n", description: "d", memory_type: "fact", content: "c" });
    expect(created.status).toBe("candidate");
    const result = await repository.approveCandidate({ tenant_id: "t1", candidate_id: "c1", reviewer_user_id: "admin", expected_version: 1 });
    expect(executor.transactions).toBe(1);
    expect(result.outcome).toBe("published");
    expect(result.outcome === "published" && result.scope_revision).toBe(1);
  });
});
