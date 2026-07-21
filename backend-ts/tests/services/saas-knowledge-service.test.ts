import { describe, expect, it, vi } from "vitest";
import { KnowledgeApplicationService } from "../../src/services/knowledge/knowledge-application-service.js";

const vectorizer = { model_id: 7, vectorizer_key: "embed", provider_key: "local", provider_type: null, model_name: "hash-64", distance_metric: "cosine", created_at: "2026-01-01T00:00:00Z", vector_dimension: 64, is_active: true };
const model = { getProvider: vi.fn(), hasProvider: vi.fn().mockReturnValue(true) };

describe("KnowledgeApplicationService with SaaS adapters", () => {
  it("searches PGVector through tenant-scoped async ports", async () => {
    const config = { listVectorizers: vi.fn().mockResolvedValue([vectorizer]), listRerankers: vi.fn().mockResolvedValue([]), getVectorizerByKey: vi.fn(), createVectorizer: vi.fn() };
    const vectors = { search: vi.fn().mockResolvedValue([{ id: "v1", tenant_id: "tenant-a", collection: "docs", document_id: "file-1", model_id: 7, chunk_index: 0, content: "hello world", metadata: {}, vector_score: 0.9 }]), listCollections: vi.fn().mockResolvedValue([]), listDocumentIndexes: vi.fn().mockResolvedValue([]), countVectorsByModel: vi.fn().mockResolvedValue([]), getDimension: vi.fn().mockResolvedValue(null), deleteChunks: vi.fn(), upsertChunks: vi.fn() };
    const service = new KnowledgeApplicationService("tenant-a", model as never, config as never, vectors as never);
    const result = await service.search({ query: "hello", collection: "docs", top_k: 3 });
    expect(result.count).toBe(1);
    expect(vectors.search).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a", collection: "docs", model_id: 7 }));
  });

  it("indexes chunks without constructing a local vector store", async () => {
    const config = { getVectorizerByKey: vi.fn().mockResolvedValue(vectorizer), listVectorizers: vi.fn(), createVectorizer: vi.fn(), setVectorDimension: vi.fn().mockResolvedValue(undefined) };
    const vectors = { search: vi.fn(), listCollections: vi.fn(), replaceChunks: vi.fn().mockResolvedValue(undefined) };
    const service = new KnowledgeApplicationService("tenant-a", model as never, config as never, vectors as never);
    const result = await service.indexExternalFile({ collection: "docs", file_id: "file-1", vectorizer_key: "embed" }, { id: "file-1", original_name: "a.md", stored_name: "a", stored_path: "object://a", size: 11, mime: "text/markdown", uploaded_at: "2026-01-01T00:00:00Z", md_blob_hash: null }, "hello world");
    expect(result.indexed_chunks).toBe(1);
    expect(config.setVectorDimension).toHaveBeenCalledWith("tenant-a", "embed", 64);
    expect(vectors.replaceChunks).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: "tenant-a",
      collection: "docs",
      document_id: "file-1",
      model_id: 7,
      records: expect.arrayContaining([expect.objectContaining({ tenant_id: "tenant-a", model_id: 7 })]),
    }));
  });

  it("keeps existing vectors when embedding fails before replacement", async () => {
    const config = {
      getVectorizerByKey: vi.fn().mockResolvedValue(vectorizer),
      setVectorDimension: vi.fn(),
    };
    const vectors = {
      deleteChunks: vi.fn().mockResolvedValue(1),
      upsertChunks: vi.fn(),
      replaceChunks: vi.fn(),
    };
    const service = new KnowledgeApplicationService(
      "tenant-a",
      model as never,
      config as never,
      vectors as never,
      () => ({ embed: vi.fn().mockRejectedValue(new Error("embedding unavailable")) }) as never,
    );

    await expect(service.indexExternalFile(
      { collection: "docs", file_id: "file-1", vectorizer_key: "embed" },
      { id: "file-1", original_name: "a.md", stored_name: "a", stored_path: "object://a", size: 11, mime: "text/markdown", uploaded_at: "2026-01-01T00:00:00Z", md_blob_hash: null },
      "hello world",
    )).rejects.toThrow("embedding unavailable");
    expect(vectors.deleteChunks).not.toHaveBeenCalled();
    expect(vectors.upsertChunks).not.toHaveBeenCalled();
    expect(vectors.replaceChunks).not.toHaveBeenCalled();
  });

  it("projects tenant file index status from PostgreSQL vector rows", async () => {
    const config = { listVectorizers: vi.fn().mockResolvedValue([vectorizer]) };
    const vectors = {
      listDocumentIndexes: vi.fn().mockResolvedValue([
        { collection: "docs", document_id: "file-1", model_id: 7, chunk_count: 2 },
      ]),
      countVectorsByModel: vi.fn().mockResolvedValue([]),
      getDimension: vi.fn().mockResolvedValue(null),
    };
    const service = new KnowledgeApplicationService("tenant-a", model as never, config as never, vectors as never);
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

  it("keeps Local-compatible one-row file status across collections and model chunk sizes", async () => {
    const secondVectorizer = { ...vectorizer, model_id: 8, vectorizer_key: "embed-large", model_name: "hash-128", vector_dimension: 128 };
    const config = { listVectorizers: vi.fn().mockResolvedValue([vectorizer, secondVectorizer]) };
    const vectors = {
      listDocumentIndexes: vi.fn().mockResolvedValue([
        { collection: "archive", document_id: "file-1", model_id: 7, chunk_count: 2 },
        { collection: "docs", document_id: "file-1", model_id: 7, chunk_count: 2 },
        { collection: "docs", document_id: "file-1", model_id: 8, chunk_count: 3 },
      ]),
      countVectorsByModel: vi.fn().mockResolvedValue([]),
      getDimension: vi.fn().mockResolvedValue(null),
    };
    const service = new KnowledgeApplicationService("tenant-a", model as never, config as never, vectors as never);
    const result = await service.fileStatus([{
      id: "file-1", original_name: "a.md", stored_name: "a", stored_path: "object://a",
      size: 11, mime: "text/markdown", uploaded_at: "2026-01-01T00:00:00Z", md_blob_hash: null,
    }]);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      collection: "docs",
      chunk_count: 3,
      vectorizer_status: { embed: "未索引", "embed-large": "已索引" },
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
    const service = new KnowledgeApplicationService("tenant-a", model as never, config as never, {} as never);

    await expect(service.listRerankers()).resolves.toEqual([expect.objectContaining({ reranker_key: "bm25_local", api_key_set: false })]);
    await expect(service.addReranker({ mode: "lexical" })).resolves.toEqual({ reranker_key: "bm25_local" });
    await expect(service.activateReranker("bm25_local")).resolves.toEqual({ active_reranker_key: "bm25_local" });
    await expect(service.deleteReranker("bm25_local")).resolves.toEqual({ deleted_reranker_key: "bm25_local" });
    expect(config.createReranker).toHaveBeenCalledWith("tenant-a", expect.objectContaining({ mode: "lexical" }));
  });

  it("updates every model version of an opaque PostgreSQL chunk id", async () => {
    const secondVectorizer = { ...vectorizer, model_id: 8, vectorizer_key: "embed-large", model_name: "hash-128", vector_dimension: 128 };
    const baseChunk = { id: "018f8e25-7b2a-4a88-9f6d-8df40ed40f10", tenant_id: "tenant-a", collection: "docs", document_id: "file-1", model_id: 7, chunk_index: 0, content: "old", metadata: {} };
    const config = { listVectorizers: vi.fn().mockResolvedValue([vectorizer, secondVectorizer]) };
    const vectors = {
      getChunk: vi.fn().mockResolvedValue(baseChunk),
      listChunkVersions: vi.fn().mockResolvedValue([baseChunk, { ...baseChunk, id: "018f8e25-7b2a-4a88-9f6d-8df40ed40f11", model_id: 8 }]),
      upsertChunks: vi.fn().mockResolvedValue(undefined),
    };
    const service = new KnowledgeApplicationService("tenant-a", model as never, config as never, vectors as never);

    await expect(service.updateChunk("file-1", baseChunk.id, "updated")).resolves.toMatchObject({ content: "updated", metadata: { manual: true } });
    expect(vectors.listChunkVersions).toHaveBeenCalledWith("tenant-a", baseChunk.id);
    expect(vectors.upsertChunks).toHaveBeenCalledWith([
      expect.objectContaining({ model_id: 7, content: "updated", metadata: { manual: true } }),
      expect.objectContaining({ model_id: 8, content: "updated", metadata: { manual: true } }),
    ]);
  });

  it("migrates source chunks and synchronizes pending documents", async () => {
    const target = { ...vectorizer, model_id: 8, vectorizer_key: "target", model_name: "hash-128", vector_dimension: null, is_active: false };
    const chunk = { id: "chunk-1", tenant_id: "tenant-a", collection: "docs", document_id: "file-1", model_id: 7, chunk_index: 0, content: "hello", metadata: {} };
    const config = {
      getVectorizerByKey: vi.fn(async (_tenant: string, key: string) => key === "embed" ? vectorizer : target),
      listVectorizers: vi.fn().mockResolvedValue([vectorizer, target]),
      setVectorDimension: vi.fn().mockResolvedValue(undefined),
    };
    const vectors = {
      listChunks: vi.fn(async (input: { model_id?: number }) => input.model_id === 8 ? [] : [chunk]),
      listDocuments: vi.fn().mockResolvedValue([{ collection: "docs", document_id: "file-1", chunk_count: 1, metadata: {} }]),
      countVectorsForDocument: vi.fn().mockResolvedValue(0),
      upsertChunks: vi.fn().mockResolvedValue(undefined),
    };
    const service = new KnowledgeApplicationService("tenant-a", model as never, config as never, vectors as never);

    await expect(service.migrate({ from_key: "embed", to_key: "target" })).resolves.toMatchObject({ migrated_chunks: 1 });
    await expect(service.syncModel(8, { collection: "docs" })).resolves.toMatchObject({ synced_documents: 1 });
    expect(vectors.upsertChunks).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ tenant_id: "tenant-a", model_id: 8 })]));
  });

  it("reports real model, collection, document, and health projections", async () => {
    const config = { listVectorizers: vi.fn().mockResolvedValue([vectorizer]), listRerankers: vi.fn().mockResolvedValue([]) };
    const vectors = {
      countVectorsByModel: vi.fn().mockResolvedValue([{ collection: "docs", count: 2 }]),
      getDimension: vi.fn().mockResolvedValue(64),
      listDocuments: vi.fn().mockResolvedValue([{ collection: "docs", document_id: "file-1", chunk_count: 2, metadata: {} }]),
      listCollections: vi.fn().mockResolvedValue([{ name: "docs", document_count: 1, chunk_count: 2, total_chunks: 2, embedding_dimension: 64 }]),
      health: vi.fn().mockResolvedValue({ status: "healthy", runtime: "pgvector", ann: true, collections_count: 1 }),
      deleteCollection: vi.fn().mockResolvedValue(2),
    };
    const service = new KnowledgeApplicationService("tenant-a", model as never, config as never, vectors as never);

    await expect(service.getModelStats(7)).resolves.toEqual({ vector_count: 2, storage_size_mb: 0, collections: { docs: 2 } });
    await expect(service.listDocuments("docs")).resolves.toMatchObject({ collection_name: "docs", total_chunks: 2, sample_ids: ["file-1"] });
    await expect(service.vectorHealth()).resolves.toMatchObject({ status: "healthy", runtime: "pgvector", collections_count: 1, vectorizers_count: 1 });
    await expect(service.deleteCollection("docs")).resolves.toMatchObject({ collection: "docs", deleted_chunks: 2 });
  });

  it("applies the active lexical reranker to hybrid search", async () => {
    const reranker = { reranker_key: "bm25_local", mode: "lexical", provider_key: "", provider_type: null, model_name: "", api_endpoint: "", api_key: null, created_at: "2026-01-01T00:00:00Z", is_active: true };
    const config = { listVectorizers: vi.fn().mockResolvedValue([vectorizer]), listRerankers: vi.fn().mockResolvedValue([reranker]) };
    const vectors = { search: vi.fn().mockResolvedValue([
      { id: "v1", tenant_id: "tenant-a", collection: "docs", document_id: "file-1", model_id: 7, chunk_index: 0, content: "unrelated", metadata: {}, vector_score: 0.9 },
      { id: "v2", tenant_id: "tenant-a", collection: "docs", document_id: "file-2", model_id: 7, chunk_index: 0, content: "hello hello", metadata: {}, vector_score: 0.5 },
    ]) };
    const service = new KnowledgeApplicationService("tenant-a", model as never, config as never, vectors as never);

    const result = await service.search({ query: "hello", collection: "docs", top_k: 2, rerank: true });
    expect(result.rerank).toBe(true);
    expect(result.rerank_mode).toBe("lexical");
    expect(result.results[0]?.document_id).toBe("file-2");
  });
});
