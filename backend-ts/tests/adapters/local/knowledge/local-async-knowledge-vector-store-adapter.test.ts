import { describe, expect, it, vi } from "vitest";

import { LocalAsyncKnowledgeVectorStoreAdapter } from "../../../../src/adapters/local/knowledge/local-async-knowledge-vector-store-adapter.js";
import type {
  IKnowledgeConfig,
  IVectorStore,
  StoredChunk,
  StoredVectorizer,
} from "../../../../src/contracts/vector-store/index.js";

const vectorizers: StoredVectorizer[] = [7, 8].map((modelId) => ({
  model_id: modelId,
  vectorizer_key: `embed-${modelId}`,
  provider_key: "local",
  provider_type: null,
  model_name: `hash-${modelId}`,
  distance_metric: "cosine",
  created_at: "2026-01-01T00:00:00.000Z",
  vector_dimension: 2,
  is_active: modelId === 7,
}));

const chunks: StoredChunk[] = [{
  id: 42,
  collection: "docs",
  document_id: "file-1",
  chunk_index: 3,
  content: "hello",
  metadata: { source: "a.md", chunk_index: 99 },
}];

function makeConfig(): IKnowledgeConfig {
  return {
    listVectorizers: vi.fn(() => vectorizers),
    getVectorizerByKey: vi.fn(),
    getVectorizerByModelId: vi.fn(),
    createVectorizer: vi.fn(),
    deleteVectorizer: vi.fn(),
    activateVectorizer: vi.fn(),
    listRerankers: vi.fn(() => []),
    getReranker: vi.fn(),
    createReranker: vi.fn(),
    deleteReranker: vi.fn(),
    activateReranker: vi.fn(),
  } as unknown as IKnowledgeConfig;
}

function makeVectors(overrides: Partial<IVectorStore> = {}): IVectorStore {
  return {
    upsertRecords: vi.fn(async () => undefined),
    replaceDocumentVectorsByModel: vi.fn(async () => undefined),
    search: vi.fn(async () => []),
    deleteDocument: vi.fn(async () => ({ deleted_chunks: 0 })),
    deleteDocumentVectors: vi.fn(async () => ({ deleted_chunks: 0 })),
    deleteDocumentVectorsByModel: vi.fn(async () => ({ deleted: 0 })),
    deleteCollection: vi.fn(async () => ({ deleted_chunks: 0 })),
    deleteByModel: vi.fn(async () => ({ deleted: 0 })),
    listCollections: vi.fn(async () => []),
    listDocuments: vi.fn(async () => []),
    countVectors: vi.fn(async () => 0),
    countVectorsByModel: vi.fn(async () => []),
    countVectorsForDocument: vi.fn(async () => 0),
    countChunks: vi.fn(async () => 0),
    listChunks: vi.fn(async () => chunks),
    listAllDocuments: vi.fn(async () => []),
    getDimension: vi.fn(() => null),
    health: vi.fn(async () => ({ status: "healthy", runtime: "sqlite_vec", ann: true, collections_count: 0 })),
    close: vi.fn(),
    ...overrides,
  };
}

describe("Local async knowledge vector store adapter", () => {
  it("maps asynchronous writes and searches to the Local vector contract", async () => {
    const vectors = makeVectors({
      search: vi.fn(async () => [{
        id: "42",
        doc_id: "file-1",
        document_id: "file-1",
        collection: "docs",
        content: "hello",
        metadata: { chunk_index: 99 },
        vector_score: 0.75,
        keyword_score: 0,
        hybrid_score: 0,
      }]),
    });
    const adapter = new LocalAsyncKnowledgeVectorStoreAdapter(vectors, makeConfig());
    await adapter.upsertChunks([{
      tenant_id: "tenant-a",
      collection: "docs",
      document_id: "file-1",
      model_id: 7,
      chunk_index: 3,
      content: "hello",
      metadata: {},
      embedding: [1, 0],
    }]);
    const hits = await adapter.search({
      tenant_id: "tenant-a",
      collection: "docs",
      model_id: 7,
      query_vector: [1, 0],
      top_k: 5,
    });

    expect(vectors.upsertRecords).toHaveBeenCalledWith([expect.objectContaining({
      doc_id: "file-1", model_id: 7, chunk_index: 3,
    })]);
    expect(vectors.search).toHaveBeenCalledWith(expect.objectContaining({ search_mode: "vector" }));
    expect(hits).toEqual([expect.objectContaining({
      id: "42", tenant_id: "tenant-a", model_id: 7, chunk_index: 3,
    })]);
  });

  it("delegates atomic document-model replacement to the Local driver", async () => {
    const vectors = makeVectors();
    const adapter = new LocalAsyncKnowledgeVectorStoreAdapter(vectors, makeConfig());
    await adapter.replaceChunks({
      tenant_id: "tenant-a",
      collection: "docs",
      document_id: "file-1",
      model_id: 7,
      records: [{
        tenant_id: "tenant-a", collection: "docs", document_id: "file-1", model_id: 7,
        chunk_index: 0, content: "replacement", metadata: {}, embedding: [1, 0],
      }],
    });
    expect(vectors.replaceDocumentVectorsByModel).toHaveBeenCalledWith(
      "docs",
      "file-1",
      7,
      [expect.objectContaining({ doc_id: "file-1", content: "replacement" })],
    );
  });

  it("keeps numeric Local chunk ids opaque and expands versions by logical coordinate", async () => {
    const vectors = makeVectors({
      countVectorsForDocument: vi.fn(async (_collection, _documentId, modelId) => modelId === 7 || modelId === 8 ? 1 : 0),
    });
    const adapter = new LocalAsyncKnowledgeVectorStoreAdapter(vectors, makeConfig());

    await expect(adapter.getChunk("tenant-a", "42")).resolves.toMatchObject({ id: "42", model_id: 7 });
    await expect(adapter.getChunk("tenant-a", "042")).resolves.toBeNull();
    await expect(adapter.listChunkVersions("tenant-a", "42")).resolves.toEqual([
      expect.objectContaining({ id: "42", collection: "docs", document_id: "file-1", chunk_index: 3, model_id: 7 }),
      expect.objectContaining({ id: "42", collection: "docs", document_id: "file-1", chunk_index: 3, model_id: 8 }),
    ]);
  });

  it("projects model-specific document indexes and chunks from Local shared chunk rows", async () => {
    const vectors = makeVectors({
      listAllDocuments: vi.fn(async () => [{
        collection: "docs", document_id: "file-1", chunk_count: 1, metadata: { source: "a.md" },
      }]),
      countVectorsForDocument: vi.fn(async (_collection, _documentId, modelId) => modelId === 7 ? 1 : 0),
    });
    const adapter = new LocalAsyncKnowledgeVectorStoreAdapter(vectors, makeConfig());

    await expect(adapter.listDocumentIndexes("tenant-a")).resolves.toEqual([{
      collection: "docs", document_id: "file-1", model_id: 7, chunk_count: 1,
    }]);
    await expect(adapter.listChunks({ tenant_id: "tenant-a", collection: "docs", model_id: 7 }))
      .resolves.toEqual([expect.objectContaining({ id: "42", tenant_id: "tenant-a", model_id: 7 })]);
    await expect(adapter.listChunks({ tenant_id: "tenant-a", collection: "docs", model_id: 8 }))
      .resolves.toEqual([]);
  });

  it("maps filtered deletion scopes to the narrowest Local primitives", async () => {
    const vectors = makeVectors({
      deleteDocumentVectorsByModel: vi.fn(async () => ({ deleted: 2 })),
      deleteDocument: vi.fn(async () => ({ deleted_chunks: 3 })),
      deleteByModel: vi.fn(async () => ({ deleted: 4 })),
      deleteCollection: vi.fn(async () => ({ deleted_chunks: 5 })),
    });
    const adapter = new LocalAsyncKnowledgeVectorStoreAdapter(vectors, makeConfig());

    await expect(adapter.deleteChunks({ tenant_id: "tenant-a", collection: "docs", document_id: "file-1", model_id: 7 })).resolves.toBe(2);
    await expect(adapter.deleteChunks({ tenant_id: "tenant-a", collection: "docs", document_id: "file-1" })).resolves.toBe(3);
    await expect(adapter.deleteChunks({ tenant_id: "tenant-a", model_id: 7 })).resolves.toBe(4);
    await expect(adapter.deleteCollection({ tenant_id: "tenant-a", collection: "docs" })).resolves.toBe(5);
  });

  it("rejects replacement records outside the declared tenant and document scope", async () => {
    const vectors = makeVectors();
    const adapter = new LocalAsyncKnowledgeVectorStoreAdapter(vectors, makeConfig());

    await expect(adapter.replaceChunks({
      tenant_id: "tenant-a",
      collection: "docs",
      document_id: "file-1",
      model_id: 7,
      records: [{
        tenant_id: "tenant-b",
        collection: "docs",
        document_id: "file-1",
        model_id: 7,
        chunk_index: 0,
        content: "wrong tenant",
        metadata: {},
        embedding: [1, 0],
      }],
    })).rejects.toThrow("replacement chunks must match");
    expect(vectors.replaceDocumentVectorsByModel).not.toHaveBeenCalled();
  });
});
