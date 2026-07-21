import { describe, expect, it, vi } from "vitest";
import { PostgresPgVectorRepository } from "../../../../src/adapters/saas/postgres/pgvector-repository.js";
import { POSTGRES_PGVECTOR_MIGRATIONS } from "../../../../src/adapters/saas/postgres/pgvector-schema.js";
import type { PostgresMemoryExecutor } from "../../../../src/adapters/saas/postgres/memory-repository.js";

const executor = (rows: Record<string, unknown>[] = []): PostgresMemoryExecutor => {
  const db = {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
    transaction: vi.fn(async (fn: (tx: PostgresMemoryExecutor) => Promise<unknown>) => fn(db as PostgresMemoryExecutor)),
  };
  return db as PostgresMemoryExecutor;
};

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
  it("replaces one document model atomically", async () => {
    const transactionQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const db = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      transaction: vi.fn(async (fn: (tx: PostgresMemoryExecutor) => Promise<unknown>) => fn({
        query: transactionQuery as never,
        transaction: vi.fn() as never,
      })),
    } as unknown as PostgresMemoryExecutor;
    await new PostgresPgVectorRepository(db).replaceChunks({
      tenant_id: "t1", collection: "docs", document_id: "d1", model_id: 2,
      records: [{ tenant_id: "t1", collection: "docs", document_id: "d1", model_id: 2, chunk_index: 0, content: "new", metadata: {}, embedding: [1, 0] }],
    });
    expect(db.transaction).toHaveBeenCalledOnce();
    const calls = transactionQuery.mock.calls as unknown as unknown[][];
    expect(String(calls[0]?.[0])).toContain("DELETE FROM knowledge_vector_chunks");
    expect(String(calls[1]?.[0])).toContain("INSERT INTO knowledge_vector_chunks");
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
  it("lists document index summaries only for the requested tenant", async () => {
    const db = executor([{ collection: "docs", document_id: "file-1", model_id: 7, chunk_count: 2 }]);
    const documents = await new PostgresPgVectorRepository(db).listDocumentIndexes("t1");
    expect(documents).toEqual([{ collection: "docs", document_id: "file-1", model_id: 7, chunk_count: 2 }]);
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain("GROUP BY collection,document_id,model_id");
    expect(call?.[1]).toEqual(["t1"]);
  });

  it("lists tenant document chunks with optional filters", async () => {
    const db = executor([{
      id: "chunk-1", tenant_id: "t1", collection: "docs", document_id: "file-1",
      model_id: 7, chunk_index: 2, content: "content", metadata: JSON.stringify({ source: "a.md" }),
    }]);
    const chunks = await new PostgresPgVectorRepository(db).listChunks({
      tenant_id: "t1", collection: "docs", document_id: "file-1", model_id: 7,
    });
    expect(chunks).toEqual([{
      id: "chunk-1", tenant_id: "t1", collection: "docs", document_id: "file-1",
      model_id: 7, chunk_index: 2, content: "content", metadata: { source: "a.md" },
    }]);
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain("tenant_id=$1");
    expect(String(call?.[0])).toContain("document_id=$3");
    expect(call?.[1]).toEqual(["t1", "docs", "file-1", 7]);
  });

  it("deduplicates logical chunks when no vectorizer model is selected", async () => {
    const db = executor();
    await new PostgresPgVectorRepository(db).listChunks({ tenant_id: "t1", document_id: "file-1" });
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain("DISTINCT ON (collection,document_id,chunk_index)");
    expect(String(call?.[0])).toContain("ORDER BY collection,document_id,chunk_index,model_id");
    expect(call?.[1]).toEqual(["t1", "file-1"]);
  });

  it("fetches a chunk by UUID without crossing tenants", async () => {
    const chunkId = "018f8e25-7b2a-0a88-1f6d-8df40ed40f10";
    const db = executor([{
      id: chunkId, tenant_id: "t1", collection: "docs", document_id: "file-1",
      model_id: 7, chunk_index: 2, content: "content", metadata: {},
    }]);
    await expect(new PostgresPgVectorRepository(db).getChunk("t1", chunkId))
      .resolves.toMatchObject({ id: chunkId, tenant_id: "t1" });
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain("tenant_id=$1");
    expect(String(call?.[0])).toContain("md5(tenant_id || chr(31) || collection");
    expect(call?.[1]).toEqual(["t1", chunkId]);
  });

  it("lists every model version of one logical chunk inside the tenant", async () => {
    const chunkId = "018f8e25-7b2a-0a88-1f6d-8df40ed40f10";
    const db = executor([{
      id: chunkId, tenant_id: "t1", collection: "docs", document_id: "file-1",
      model_id: 8, chunk_index: 2, content: "content", metadata: {},
    }]);
    await expect(new PostgresPgVectorRepository(db).listChunkVersions("t1", chunkId))
      .resolves.toHaveLength(1);
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain("SELECT DISTINCT collection,document_id,chunk_index");
    expect(String(call?.[0])).toContain("WHERE tenant_id=$1 AND md5(tenant_id || chr(31) || collection");
    expect(String(call?.[0])).toContain("WHERE chunk.tenant_id=$1");
    expect(call?.[1]).toEqual(["t1", chunkId]);
  });

  it("does not send non-UUID Local chunk ids to PostgreSQL UUID casts", async () => {
    const db = executor();
    const repo = new PostgresPgVectorRepository(db);

    await expect(repo.getChunk("t1", "42")).resolves.toBeNull();
    await expect(repo.listChunkVersions("t1", "42")).resolves.toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it("aggregates documents without multiplying chunks across vectorizers", async () => {
    const db = executor([{ collection: "docs", document_id: "file-1", chunk_count: 3, metadata: { source: "a.md" } }]);
    const documents = await new PostgresPgVectorRepository(db).listDocuments({ tenant_id: "t1", collection: "docs" });
    expect(documents).toEqual([{
      collection: "docs", document_id: "file-1", chunk_count: 3, metadata: { source: "a.md" },
    }]);
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain("COUNT(DISTINCT chunk_index)");
    expect(call?.[1]).toEqual(["t1", "docs"]);
  });

  it("returns tenant-scoped model counts, dimensions, and health", async () => {
    const modelDb = executor([{ collection: "docs", count: 4 }]);
    await expect(new PostgresPgVectorRepository(modelDb).countVectorsByModel({ tenant_id: "t1", model_id: 7 }))
      .resolves.toEqual([{ collection: "docs", count: 4 }]);
    expect((modelDb.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual(["t1", 7]);

    const dimensionDb = executor([{ dimension: 1536 }]);
    await expect(new PostgresPgVectorRepository(dimensionDb).getDimension({ tenant_id: "t1", model_id: 7 }))
      .resolves.toBe(1536);
    expect((dimensionDb.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual(["t1", 7]);

    const healthDb = executor([{ count: 2 }]);
    await expect(new PostgresPgVectorRepository(healthDb).health("t1")).resolves.toEqual({
      status: "healthy", runtime: "pgvector", ann: true, collections_count: 2,
    });
    expect((healthDb.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual(["t1"]);
  });

  it("deletes a collection through the same tenant-scoped primitive", async () => {
    const db = executor([{ count: 2 }]);
    await expect(new PostgresPgVectorRepository(db).deleteCollection({ tenant_id: "t1", collection: "docs" }))
      .resolves.toBe(2);
    const call = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(call?.[0])).toContain("COUNT(DISTINCT (document_id,chunk_index))");
    expect(String(call?.[0])).toContain("tenant_id=$1 AND collection=$2");
    expect(call?.[1]).toEqual(["t1", "docs"]);
  });
});
