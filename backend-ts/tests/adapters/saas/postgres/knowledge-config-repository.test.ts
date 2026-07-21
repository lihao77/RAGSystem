import { describe, expect, it, vi } from "vitest";
import { PostgresKnowledgeConfigRepository } from "../../../../src/adapters/saas/postgres/knowledge-config-repository.js";
import { POSTGRES_KNOWLEDGE_CONFIG_MIGRATIONS } from "../../../../src/adapters/saas/postgres/knowledge-config-schema.js";
import type { PostgresMemoryExecutor } from "../../../../src/adapters/saas/postgres/memory-repository.js";

const executor = (rows: Record<string, unknown>[] = []): PostgresMemoryExecutor => {
  const db = {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    transaction: vi.fn(async (fn: (tx: PostgresMemoryExecutor) => unknown) => fn(db)),
  } as unknown as PostgresMemoryExecutor;
  return db;
};

describe("Postgres knowledge config", () => {
  it("uses tenant-scoped PostgreSQL tables and no local database path", () => {
    expect(POSTGRES_KNOWLEDGE_CONFIG_MIGRATIONS[0]?.sql).toContain("knowledge_vectorizers");
    expect(POSTGRES_KNOWLEDGE_CONFIG_MIGRATIONS[0]?.sql).toContain("tenant_id TEXT NOT NULL");
    expect(POSTGRES_KNOWLEDGE_CONFIG_MIGRATIONS[0]?.sql).not.toContain("sqlite");
    expect(POSTGRES_KNOWLEDGE_CONFIG_MIGRATIONS[0]?.sql).not.toContain("ragsystem.db");
    expect(POSTGRES_KNOWLEDGE_CONFIG_MIGRATIONS[1]?.sql).toContain("knowledge_rerankers");
  });

  it("scopes vectorizer reads and creates the first active config in PostgreSQL", async () => {
    const db = executor([{ model_id: 1, tenant_id: "t1", vectorizer_key: "embed", provider_key: "local", provider_type: null, model_name: "hash-64", distance_metric: "cosine", created_at: "2026-01-01T00:00:00Z", is_active: true, vector_dimension: 64 }]);
    const repo = new PostgresKnowledgeConfigRepository(db);
    await repo.listVectorizers("t1");
    await repo.createVectorizer("t1", { vectorizer_key: "embed", provider_key: "local", provider_type: null, model_name: "hash-64", distance_metric: "cosine" });
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual(["t1"]);
    expect(String((db.query as ReturnType<typeof vi.fn>).mock.calls[1]?.[0])).toContain("pg_advisory_xact_lock");
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toEqual(["t1"]);
    expect(String((db.query as ReturnType<typeof vi.fn>).mock.calls[2]?.[0])).toContain("knowledge_vectorizers");
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]?.[0]).toBe("t1");
  });

  it("scopes reranker reads and creates by tenant", async () => {
    const row = { tenant_id: "t1", reranker_key: "bm25_local", mode: "lexical", provider_key: "", provider_type: null, model_name: "", api_endpoint: "", api_key: null, created_at: "2026-01-01T00:00:00Z", is_active: true };
    const db = executor([row]);
    const repo = new PostgresKnowledgeConfigRepository(db);
    await expect(repo.listRerankers("t1")).resolves.toEqual([expect.objectContaining({ reranker_key: "bm25_local" })]);
    await repo.createReranker("t1", row);
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual(["t1"]);
    expect(String((db.query as ReturnType<typeof vi.fn>).mock.calls[1]?.[0])).toContain("pg_advisory_xact_lock");
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toEqual(["t1"]);
    expect(String((db.query as ReturnType<typeof vi.fn>).mock.calls[2]?.[0])).toContain("knowledge_rerankers");
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]?.[0]).toBe("t1");
  });
});
