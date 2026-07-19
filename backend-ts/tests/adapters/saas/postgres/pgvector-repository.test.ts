import { describe, expect, it, vi } from "vitest";
import { PostgresPgVectorRepository } from "../../../../src/adapters/saas/postgres/pgvector-repository.js";
import { POSTGRES_PGVECTOR_MIGRATIONS } from "../../../../src/adapters/saas/postgres/pgvector-schema.js";
import type { PostgresMemoryExecutor } from "../../../../src/adapters/saas/postgres/memory-repository.js";

const executor = (rows: Record<string, unknown>[] = []): PostgresMemoryExecutor => ({ query: vi.fn(async () => ({ rows, rowCount: rows.length })), transaction: vi.fn(async (fn) => fn(executor(rows))) });

describe("Postgres pgvector adapter", () => {
  it("defines vector extension and tenant-scoped table", () => {
    expect(POSTGRES_PGVECTOR_MIGRATIONS[0]?.sql).toContain("CREATE EXTENSION IF NOT EXISTS vector");
    expect(POSTGRES_PGVECTOR_MIGRATIONS[0]?.sql).toContain("tenant_id TEXT NOT NULL");
  });
  it("upserts vectors and scopes search by tenant", async () => {
    const db = executor([{ id: "v1", tenant_id: "t1", collection: "docs", document_id: "d1", model_id: 2, chunk_index: 0, content: "hello", metadata: {}, vector_score: 0.9 }]);
    const repo = new PostgresPgVectorRepository(db);
    await repo.upsertChunks([{ tenant_id: "t1", collection: "docs", document_id: "d1", model_id: 2, chunk_index: 0, content: "hello", metadata: {}, embedding: [1, 0] }]);
    const hits = await repo.search({ tenant_id: "t1", collection: "docs", model_id: 2, query_vector: [1, 0], top_k: 3 });
    expect(hits[0]?.tenant_id).toBe("t1");
    expect(String((db.query as ReturnType<typeof vi.fn>).mock.calls[1]?.[0])).toContain("tenant_id=$1");
  });
  it("deletes only the requested tenant scope", async () => {
    const db = executor();
    await new PostgresPgVectorRepository(db).deleteChunks({ tenant_id: "t1", collection: "docs", model_id: 4 });
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain("tenant_id=$1");
    expect(call?.[1]).toEqual(["t1", "docs", 4]);
  });
  it("lists collection summaries only for the requested tenant", async () => {
    const db = executor([{ name: "docs", document_count: 2, chunk_count: 7, embedding_dimension: null }]);
    const collections = await new PostgresPgVectorRepository(db).listCollections("t1");
    expect(collections).toEqual([{
      name: "docs",
      document_count: 2,
      chunk_count: 7,
      total_chunks: 7,
      embedding_dimension: null,
    }]);
    expect((db.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual(["t1"]);
  });
});
