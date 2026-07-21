import { describe, expect, it } from "vitest";

import type {
  IKnowledgeConfig,
  IKnowledgeFileStore,
  IVectorStore,
  KnowledgeFile,
  StoredReranker,
  VectorSearchHit,
} from "../../src/contracts/vector-store/index.js";
import { LocalAsyncKnowledgeConfigAdapter } from "../../src/adapters/local/knowledge/local-async-knowledge-config-adapter.js";
import { LocalAsyncKnowledgeVectorStoreAdapter } from "../../src/adapters/local/knowledge/local-async-knowledge-vector-store-adapter.js";
import { ModelAdapterService } from "../../src/services/integrations/model-adapter-service.js";
import { KnowledgeApplicationService } from "../../src/services/knowledge/knowledge-application-service.js";

/**
 * Minimal IVectorStore & IKnowledgeConfig stub: search returns preset hits, config stays in-memory.
 * Focuses on application orchestration (keyword/hybrid + rerank) — driver config is covered elsewhere.
 */
function makeFakeDriver(
  hits: VectorSearchHit[],
  dimension: number | null = null,
  rerankers: StoredReranker[] = [],
): IVectorStore & IKnowledgeConfig & IKnowledgeFileStore {
  const vectorizers: Array<ReturnType<IKnowledgeConfig["createVectorizer"]>> = [];
  return {
    upsertRecords: async () => {},
    replaceDocumentVectorsByModel: async () => {},
    search: async () => hits,
    deleteDocument: async () => ({ deleted_chunks: 0 }),
    deleteDocumentVectors: async () => ({ deleted_chunks: 0 }),
    deleteDocumentVectorsByModel: async () => ({ deleted: 0 }),
    deleteCollection: async () => ({ deleted_chunks: 0 }),
    deleteByModel: async () => ({ deleted: 0 }),
    listCollections: async () => [],
    listDocuments: async () => [],
    countVectors: async () => 0,
    countVectorsByModel: async () => [],
    countVectorsForDocument: async () => 0,
    countChunks: async () => 0,
    listChunks: async () => hits.map((hit, index) => ({
      id: Number(hit.id) || index + 1,
      collection: hit.collection,
      document_id: hit.document_id,
      chunk_index: index,
      content: hit.content,
      metadata: hit.metadata,
    })),
    listAllDocuments: async () => [],
    getDimension: () => dimension,
    health: async () => ({ status: "healthy", runtime: "mock", ann: true, collections_count: 0 }),
    close: () => {},
    listVectorizers: () => vectorizers,
    getVectorizerByKey: (key) => vectorizers.find((v) => v.vectorizer_key === key) ?? null,
    getVectorizerByModelId: (modelId) => vectorizers.find((v) => v.model_id === modelId) ?? null,
    createVectorizer: (input) => {
      const stored = {
        model_id: vectorizers.length + 1,
        vectorizer_key: input.vectorizer_key,
        provider_key: input.provider_key,
        provider_type: input.provider_type,
        model_name: input.model_name,
        distance_metric: input.distance_metric,
        created_at: new Date().toISOString(),
        vector_dimension: null,
        is_active: vectorizers.length === 0,
      };
      vectorizers.push(stored);
      return stored;
    },
    deleteVectorizer: (key) => {
      const idx = vectorizers.findIndex((v) => v.vectorizer_key === key);
      if (idx >= 0) vectorizers.splice(idx, 1);
      const next = vectorizers[0];
      if (next) next.is_active = true;
      return { next_active_key: next?.vectorizer_key ?? null };
    },
    activateVectorizer: (key) => {
      for (const v of vectorizers) v.is_active = v.vectorizer_key === key;
    },
    listRerankers: () => rerankers,
    getReranker: (key) => rerankers.find((reranker) => reranker.reranker_key === key) ?? null,
    createReranker: (input) => ({
      reranker_key: input.reranker_key,
      mode: input.mode,
      provider_key: input.provider_key,
      provider_type: input.provider_type,
      model_name: input.model_name,
      api_endpoint: input.api_endpoint,
      api_key: input.api_key,
      created_at: new Date().toISOString(),
      is_active: true,
    }),
    deleteReranker: () => ({ next_active_key: null }),
    activateReranker: () => {},
    listKnowledgeFiles: () => [],
    getKnowledgeFile: () => null,
    addKnowledgeFile: (input) => ({
      id: "kf1",
      original_name: input.originalName,
      stored_name: "stored",
      stored_path: "/tmp/kb-test/stored",
      size: input.buffer.byteLength,
      mime: input.mime,
      uploaded_at: new Date().toISOString(),
      md_blob_hash: null,
    }) satisfies KnowledgeFile,
    deleteKnowledgeFile: () => null,
    getKnowledgeUploadsRoot: () => "/tmp/kb-test",
    putKnowledgeMarkdown: () => ({ md_blob_hash: "0".repeat(64) }),
    readKnowledgeMarkdown: () => "",
  } satisfies IVectorStore & IKnowledgeConfig & IKnowledgeFileStore;
}

function makeService(
  driver: IVectorStore & IKnowledgeConfig,
  options?: {
    embedderFactory?: ConstructorParameters<typeof KnowledgeApplicationService>[4];
    rerankerFactory?: ConstructorParameters<typeof KnowledgeApplicationService>[5];
  },
) {
  return new KnowledgeApplicationService(
    "tnt_local",
    new ModelAdapterService({ providersConfigPath: "" }),
    new LocalAsyncKnowledgeConfigAdapter(driver),
    new LocalAsyncKnowledgeVectorStoreAdapter(driver, driver),
    options?.embedderFactory,
    options?.rerankerFactory,
  );
}

describe("KnowledgeApplicationService search path (async ports + scoring)", () => {
  const activeReranker = (mode: StoredReranker["mode"]): StoredReranker => ({
    reranker_key: `rr-${mode}`,
    mode,
    provider_key: "p",
    provider_type: null,
    model_name: "m",
    api_endpoint: "http://rerank",
    api_key: "k",
    created_at: "now",
    is_active: true,
  });

  it("远端 embedder 失败时显式失败而不是写入 hash 向量", async () => {
    const service = makeService(makeFakeDriver([]), {
      embedderFactory: () => ({
        key: "remote:test/model",
        semantic: true,
        dimension: 0,
        embed: async () => { throw new Error("embedding provider unavailable"); },
      }),
    });
    await expect(service.search({ collection_name: "kb", query: "probe", top_k: 5 }))
      .rejects.toThrow("embedding provider unavailable");
  });

  it("driver 召回后补 keyword/hybrid 并按 hybrid 排序", async () => {
    const hits: VectorSearchHit[] = [
      {
        id: "1", doc_id: "d1", document_id: "d1", collection: "kb",
        content: "TypeScript RAG retrieval backend supports knowledge base search",
        metadata: { source_file: "rag.md" },
        vector_score: 0.8, keyword_score: 0, hybrid_score: 0,
      },
      {
        id: "2", doc_id: "d2", document_id: "d2", collection: "kb",
        content: "unrelated cooking recipe with salt and pepper",
        metadata: {},
        vector_score: 0.3, keyword_score: 0, hybrid_score: 0,
      },
    ];
    const service = makeService(makeFakeDriver(hits));
    const result = await service.search({
      collection_name: "kb", query: "RAG retrieval backend", top_k: 5, search_mode: "hybrid",
    });
    expect(result.count).toBe(2);
    const first = result.results[0]!;
    expect(first.document_id).toBe("d1");
    expect(Number(first.vector_score)).toBeCloseTo(0.8, 4);
    expect(Number(first.keyword_score)).toBeGreaterThan(0);
    expect(Number(first.hybrid_score)).toBeGreaterThan(Number(first.vector_score) * 0.7);
  });

  it("rerank 开启时按 keyword 重排 hybrid 结果", async () => {
    const hits: VectorSearchHit[] = [
      {
        id: "1", doc_id: "d1", document_id: "d1", collection: "kb",
        content: "alpha vector space model baseline",
        metadata: {},
        vector_score: 0.9, keyword_score: 0, hybrid_score: 0,
      },
      {
        id: "2", doc_id: "d2", document_id: "d2", collection: "kb",
        content: "rag retrieval keyword overlap match",
        metadata: {},
        vector_score: 0.4, keyword_score: 0, hybrid_score: 0,
      },
    ];
    const service = makeService(makeFakeDriver(hits, null, [activeReranker("lexical")]));
    const result = await service.search({
      collection_name: "kb", query: "keyword overlap", top_k: 5, search_mode: "hybrid", rerank: true,
    });
    const ids = result.results.map((r) => r.document_id);
    expect(ids[0]).toBe("d2");
  });

  it("vectorStore 无命中时 search 返回空候选", async () => {
    const service = makeService(makeFakeDriver([]));
    const result = await service.search({ collection_name: "kb", query: "anything", top_k: 5 });
    expect(result.count).toBe(0);
  });

  it("listVectorizers 显示 driver 真维度(替占位 64)", async () => {
    const service = makeService(makeFakeDriver([], 1536));
    await service.search({ collection_name: "kb", query: "probe", top_k: 5 });
    const active = (await service.listVectorizers()).find((vectorizer) => vectorizer.vectorizer_key === "local_hash_embedding");
    expect(active).toBeTruthy();
    expect(active?.vector_dimension).toBe(1536);
  });

  it("model reranker 成功返回 model", async () => {
    const hits: VectorSearchHit[] = [{
      id: "1", doc_id: "d1", document_id: "d1", collection: "kb", content: "first", metadata: {},
      vector_score: 0.9, keyword_score: 0, hybrid_score: 0,
    }];
    const service = makeService(makeFakeDriver(hits, null, [activeReranker("model")]), {
      rerankerFactory: () => ({
        rerank: async (_query, results) => ({
          results: results.map((result) => ({ ...result, rerank_score: 0.9 })),
          mode: "model",
        }),
      }),
    });
    await expect(service.search({ collection_name: "kb", query: "q", search_mode: "hybrid", rerank: true }))
      .resolves.toMatchObject({ rerank_mode: "model" });
  });

  it("model reranker 失败降级并标记结果", async () => {
    const hits: VectorSearchHit[] = [{
      id: "1", doc_id: "d1", document_id: "d1", collection: "kb", content: "query match", metadata: {},
      vector_score: 0.9, keyword_score: 0, hybrid_score: 0,
    }];
    const service = makeService(makeFakeDriver(hits, null, [activeReranker("model")]), {
      rerankerFactory: () => ({
        rerank: async () => { throw new Error("offline"); },
      }),
    });
    const output = await service.search({ collection_name: "kb", query: "query", search_mode: "hybrid", rerank: true });
    expect(output).toMatchObject({ rerank_mode: "degraded" });
    expect(output.results[0]).toMatchObject({ rerank_degraded: true });
  });

  it("active mode=none 且 rerank=true 时透传并返回 none", async () => {
    const hits: VectorSearchHit[] = [{
      id: "1", doc_id: "d1", document_id: "d1", collection: "kb", content: "first", metadata: {},
      vector_score: 0.9, keyword_score: 0, hybrid_score: 0,
    }];
    const service = makeService(makeFakeDriver(hits, null, [activeReranker("none")]));
    await expect(service.search({ collection_name: "kb", query: "q", search_mode: "hybrid", rerank: true }))
      .resolves.toMatchObject({ rerank_mode: "none" });
  });
});
