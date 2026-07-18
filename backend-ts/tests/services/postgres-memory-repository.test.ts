import { describe, expect, it } from "vitest";

import type { PersistedMemoryManagementCountOptions } from "../../src/contracts/memory-store/index.js";
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

  it("keeps candidate listing and counting tenant scoped", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const executor: PostgresMemoryExecutor = {
      async query<Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        return { rows: (sql.startsWith("SELECT COUNT") ? [{ total: "3" }] : [candidateRow]) as unknown as Row[] };
      },
      async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>) { return fn(this); },
    };
    const repository = new PostgresMemoryRepository(executor);
    expect(await repository.listCandidates({ tenant_id: "tenant-a", statuses: ["candidate"], limit: 20 }))
      .toHaveLength(1);
    expect(await repository.countCandidates({ tenant_id: "tenant-a", scope: "team" })).toBe(3);
    expect(calls.every((call) => call.sql.includes("tenant_id = $1") && call.params?.[0] === "tenant-a"))
      .toBe(true);
  });

  it("filters managed entries by tenant, owner partitions, shared scopes, and search", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const executor: PostgresMemoryExecutor = {
      async query<Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        return { rows: (sql.startsWith("SELECT COUNT") ? [{ total: "1" }] : [memoryRow]) as unknown as Row[] };
      },
      async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>) { return fn(this); },
    };
    const repository = new PostgresMemoryRepository(executor);
    const visibility = {
      tenant_id: "tenant-a",
      scopes: ["user", "workspace", "session", "team", "agent"],
      statuses: ["active"],
      search: "policy",
      viewer_user_id: "user-a",
      viewer_session_ids: ["session-a"],
    } satisfies PersistedMemoryManagementCountOptions;

    await repository.listManagedEntries({ ...visibility, limit: 20, offset: 5 });
    expect(await repository.countManagedEntries(visibility)).toBe(1);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain("tenant_id = $1");
      expect(call.sql).toContain("scope IN ('team', 'agent')");
      expect(call.sql).toContain("scope = 'user' AND scope_id =");
      expect(call.sql).toContain("scope = 'workspace'");
      expect(call.sql).toContain("scope = 'session'");
      expect(call.sql).toContain("ILIKE");
      expect(call.params?.[0]).toBe("tenant-a");
      expect(call.params).toContain("user-a");
      expect(call.params).toContainEqual(["session-a"]);
    }
  });

  it("uses versions for mutation and a token for the review claim", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] | undefined }> = [];
    const executor: PostgresMemoryExecutor = {
      async query<Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, params });
        if (sql.includes("SET reviewer_user_id = $1, review_claim_token")) {
          return { rows: [{ ...candidateRow, reviewer_user_id: params?.[0], review_claim_token: params?.[1], review_claimed_at: dates.updated_at, version: 2 } as unknown as Row] };
        }
        if (sql.includes("SET status = 'rejected'")) {
          return { rows: [{ ...candidateRow, status: "rejected", reviewer_user_id: "admin", review_claim_token: null, version: 3 } as unknown as Row] };
        }
        return { rows: [] };
      },
      async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>) { return fn(this); },
    };
    const repository = new PostgresMemoryRepository(executor);
    const claimed = await repository.claimCandidate({ tenant_id: "t1", candidate_id: "c1",
      reviewer_user_id: "admin", expected_version: 1 });
    expect(claimed.outcome).toBe("claimed");
    if (claimed.outcome !== "claimed") throw new Error("claim failed");
    const rejected = await repository.rejectCandidate({ tenant_id: "t1", candidate_id: "c1",
      reviewer_user_id: "admin", review_claim_token: claimed.review_claim_token });
    expect(rejected.outcome).toBe("applied");
    expect(calls[0]?.sql).toContain("version = $5");
    expect(calls[1]?.sql).toContain("review_claim_token = $5");
    expect(calls[1]?.params?.[4]).toBe(claimed.review_claim_token);
  });

  it("does not publish a claimed candidate without its claim token", async () => {
    const calls: string[] = [];
    const executor: PostgresMemoryExecutor = {
      async query<Row extends Record<string, unknown>>(sql: string) {
        calls.push(sql);
        return { rows: (sql.includes("FOR UPDATE")
          ? [{ ...candidateRow, reviewer_user_id: "admin", review_claim_token: "claim-1", version: 2 }]
          : []) as unknown as Row[] };
      },
      async transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>) { return fn(this); },
    };
    const repository = new PostgresMemoryRepository(executor);
    const result = await repository.approveCandidate({ tenant_id: "t1", candidate_id: "c1",
      reviewer_user_id: "admin", expected_version: 2 });
    expect(result.outcome).toBe("state_conflict");
    expect(calls.some((sql) => sql.startsWith("INSERT INTO memory_entries"))).toBe(false);
  });
});
