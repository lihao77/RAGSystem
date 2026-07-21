import { describe, expect, it, vi } from "vitest";
import { SaaSKnowledgeService } from "../../src/adapters/saas/application/knowledge/saas-knowledge-service.js";

const vectorizer = { model_id: 7, vectorizer_key: "embed", provider_key: "local", provider_type: null, model_name: "hash-64", distance_metric: "cosine", created_at: "2026-01-01T00:00:00Z", vector_dimension: 64, is_active: true };
const model = { getProvider: vi.fn(), hasProvider: vi.fn().mockReturnValue(true) };

describe("SaaSKnowledgeService", () => {
  it("searches PGVector through tenant-scoped async ports", async () => {
    const config = { listVectorizers: vi.fn().mockResolvedValue([vectorizer]), getVectorizerByKey: vi.fn(), createVectorizer: vi.fn() };
    const vectors = { search: vi.fn().mockResolvedValue([{ id: "v1", tenant_id: "tenant-a", collection: "docs", document_id: "file-1", model_id: 7, chunk_index: 0, content: "hello world", metadata: {}, vector_score: 0.9 }]), listCollections: vi.fn().mockResolvedValue([]), deleteChunks: vi.fn(), upsertChunks: vi.fn() };
    const service = new SaaSKnowledgeService("tenant-a", model as never, config as never, vectors);
    const result = await service.search({ query: "hello", collection: "docs", top_k: 3 });
    expect(result.count).toBe(1);
    expect(vectors.search).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a", collection: "docs", model_id: 7 }));
  });

  it("indexes chunks without constructing a local vector store", async () => {
    const config = { getVectorizerByKey: vi.fn().mockResolvedValue(vectorizer), listVectorizers: vi.fn(), createVectorizer: vi.fn(), setVectorDimension: vi.fn().mockResolvedValue(undefined) };
    const vectors = { search: vi.fn(), listCollections: vi.fn(), deleteChunks: vi.fn().mockResolvedValue(0), upsertChunks: vi.fn().mockResolvedValue(undefined) };
    const service = new SaaSKnowledgeService("tenant-a", model as never, config as never, vectors);
    const result = await service.indexExternalFile({ collection: "docs", file_id: "file-1", vectorizer_key: "embed" }, { id: "file-1", original_name: "a.md", stored_name: "a", stored_path: "object://a", size: 11, mime: "text/markdown", uploaded_at: "2026-01-01T00:00:00Z", md_blob_hash: null }, "hello world");
    expect(result.indexed_chunks).toBe(1);
    expect(config.setVectorDimension).toHaveBeenCalledWith("tenant-a", "embed", 64);
    expect(vectors.upsertChunks).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ tenant_id: "tenant-a", model_id: 7 })]));
  });

  it("projects tenant file index status from PostgreSQL vector rows", async () => {
    const config = { listVectorizers: vi.fn().mockResolvedValue([vectorizer]) };
    const vectors = {
      listDocumentIndexes: vi.fn().mockResolvedValue([
        { collection: "docs", document_id: "file-1", model_id: 7, chunk_count: 2 },
      ]),
    };
    const service = new SaaSKnowledgeService("tenant-a", model as never, config as never, vectors as never);
    const result = await service.fileStatus([{
      id: "file-1", original_name: "a.md", stored_name: "a", stored_path: "object://a",
      size: 11, mime: "text/markdown", uploaded_at: "2026-01-01T00:00:00Z", md_blob_hash: null,
    }]);

    expect(vectors.listDocumentIndexes).toHaveBeenCalledWith("tenant-a");
    expect(result).toEqual({
      files: [expect.objectContaining({
        file_id: "file-1",
        collection: "docs",
        chunk_count: 2,
        vectorizer_status: { embed: "已索引" },
      })],
      vectorizers: [expect.objectContaining({ vectorizer_key: "embed", dimension: 64, model_id: 7 })],
    });
  });

  it("manages rerankers through the tenant-scoped PostgreSQL config port", async () => {
    const stored = { reranker_key: "bm25_local", mode: "lexical", provider_key: "", provider_type: null, model_name: "", api_endpoint: "", api_key: null, created_at: "2026-01-01T00:00:00Z", is_active: true };
    const config = {
      listRerankers: vi.fn().mockResolvedValue([stored]),
      getReranker: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(stored),
      createReranker: vi.fn().mockResolvedValue(stored),
      activateReranker: vi.fn().mockResolvedValue(undefined),
      deleteReranker: vi.fn().mockResolvedValue({ next_active_key: null }),
    };
    const service = new SaaSKnowledgeService("tenant-a", model as never, config as never, {} as never);

    await expect(service.listRerankers()).resolves.toEqual([expect.objectContaining({ reranker_key: "bm25_local", api_key_set: false })]);
    await expect(service.addReranker({ mode: "lexical" })).resolves.toEqual({ reranker_key: "bm25_local" });
    await expect(service.activateReranker("bm25_local")).resolves.toEqual({ active_reranker_key: "bm25_local" });
    await expect(service.deleteReranker("bm25_local")).resolves.toEqual({ deleted_reranker_key: "bm25_local" });
    expect(config.createReranker).toHaveBeenCalledWith("tenant-a", expect.objectContaining({ mode: "lexical" }));
  });
});
