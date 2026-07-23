import { describe, expect, it, vi } from "vitest";

import type {
  AsyncKnowledgeConfigStore,
} from "../../src/contracts/knowledge/async-knowledge-config.js";
import type {
  AsyncKnowledgeVectorStore,
  AsyncVectorSearchHit,
} from "../../src/contracts/knowledge/async-vector-store.js";
import type {
  StoredReranker,
  StoredVectorizer,
} from "../../src/contracts/vector-store/index.js";
import { ModelAdapterService } from "../../src/services/integrations/model-adapter-service.js";
import { KnowledgeApplicationService } from "../../src/services/knowledge/knowledge-application-service.js";

/**
 * Minimal Async knowledge ports stub: search returns preset hits, config stays in-memory.
 * Focuses on application orchestration (keyword/hybrid + rerank) — driver config is covered elsewhere.
 */
function makeFakePorts(
  hits: AsyncVectorSearchHit[],
  dimension: number | null = null,
  rerankers: StoredReranker[] = [],
): { config: AsyncKnowledgeConfigStore; vectors: AsyncKnowledgeVectorStore } {
  const vectorizers: StoredVectorizer[] = [];
  const config: AsyncKnowledgeConfigStore = {
    listVectorizers: async () => vectorizers,
    getVectorizerByKey: async (_tenantId, key) => vectorizers.find((v) => v.vectorizer_key === key) ?? null,
    createVectorizer: async (_tenantId, input) => {
      const stored: StoredVectorizer = {
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
    setVectorDimension: async (_tenantId, key, dim) => {
      const target = vectorizers.find((v) => v.vectorizer_key === key);
      if (target) target.vector_dimension = dim;
    },
    deleteVectorizer: async (_tenantId, key) => {
      const idx = vectorizers.findIndex((v) => v.vectorizer_key === key);
      if (idx >= 0) vectorizers.splice(idx, 1);
      const next = vectorizers[0];
      if (next) next.is_active = true;
      return { next_active_key: next?.vectorizer_key ?? null };
    },
    activateVectorizer: async (_tenantId, key) => {
      for (const v of vectorizers) v.is_active = v.vectorizer_key === key;
    },
    listRerankers: async () => rerankers,
    getReranker: async (_tenantId, key) => rerankers.find((reranker) => reranker.reranker_key === key) ?? null,
    createReranker: async (_tenantId, input) => ({
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
    deleteReranker: async () => ({ next_active_key: null }),
    activateReranker: async () => {},
  };

  const vectors: AsyncKnowledgeVectorStore = {
    upsertChunks: async () => {},
    replaceChunks: async () => {},
    search: async (input) => hits.map((hit) => ({ ...hit, tenant_id: input.tenant_id, model_id: input.model_id })),
    listCollections: async () => [],
    listDocumentIndexes: async () => [],
    listChunks: async () => hits.map((hit, index) => ({
      id: hit.id,
      tenant_id: hit.tenant_id,
      collection: hit.collection,
      document_id: hit.document_id,
      model_id: hit.model_id,
      chunk_index: hit.chunk_index ?? index,
      content: hit.content,
      metadata: hit.metadata,
    })),
    getChunk: async () => null,
    listChunkVersions: async () => [],
    listDocuments: async () => [],
    listAllDocuments: async () => [],
    countVectors: async () => 0,
    countVectorsByModel: async () => [],
    countVectorsForDocument: async () => 0,
    countChunks: async () => 0,
    getDimension: async () => dimension,
    health: async () => ({ status: "healthy", runtime: "mock", ann: true, collections_count: 0 }),
    deleteChunks: async () => 0,
    deleteCollection: async () => 0,
  };

  return { config, vectors };
}

function makeService(
  ports: { config: AsyncKnowledgeConfigStore; vectors: AsyncKnowledgeVectorStore },
  options?: {
    embedderFactory?: ConstructorParameters<typeof KnowledgeApplicationService>[4];
    rerankerFactory?: ConstructorParameters<typeof KnowledgeApplicationService>[5];
    modelAdapter?: ConstructorParameters<typeof KnowledgeApplicationService>[1];
  },
) {
  return new KnowledgeApplicationService(
    "tnt_local",
    options?.modelAdapter ?? new ModelAdapterService({ providersConfigPath: "" }),
    ports.config,
    ports.vectors,
    options?.embedderFactory,
    options?.rerankerFactory,
  );
}

function hit(
  id: string,
  documentId: string,
  content: string,
  vectorScore: number,
  metadata: Record<string, unknown> = {},
): AsyncVectorSearchHit {
  return {
    id,
    tenant_id: "tnt_local",
    collection: "kb",
    document_id: documentId,
    model_id: 1,
    chunk_index: Number(id) - 1,
    content,
    metadata,
    vector_score: vectorScore,
  };
}

describe("KnowledgeApplicationService search path (async ports + scoring)", () => {
  const rerankProviderAdapter = {
    getProvider: () => ({
      key: "p",
      name: "Provider",
      provider_type: "rerank_api",
      api_endpoint: "https://provider.example.test/v1/rerank",
      api_key: "provider-key",
      models: ["provider-rerank-model"],
      model_map: { rerank: "provider-rerank-model" },
    }),
    hasProvider: () => true,
  } as never;
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
    const service = makeService(makeFakePorts([]), {
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
    const hits = [
      hit("1", "d1", "TypeScript RAG retrieval backend supports knowledge base search", 0.8, { source_file: "rag.md" }),
      hit("2", "d2", "unrelated cooking recipe with salt and pepper", 0.3),
    ];
    const service = makeService(makeFakePorts(hits));
    const result = await service.search({
      collection_name: "kb", query: "RAG retrieval backend", top_k: 5, search_mode: "hybrid",
    });
    expect(result.count).toBe(2);
    const first = result.results[0]!;
    expect(first.document_id).toBe("d1");
    expect(Number(first.vector_score)).toBeCloseTo(0.8, 4);
    expect(Number(first.keyword_score)).toBeGreaterThan(0);
    expect(Number(first.hybrid_score)).toBeGreaterThan(Number(first.vector_score) * 0.7);
    expect(first).toMatchObject({ final_rank: 1, vector_rank: 1, hybrid_rank: 1, score_type: "hybrid", retrieval_sources: ["vector"] });
    expect(result.diagnostics).toMatchObject({ candidate_count: 2, vectorizer: { vectorizer_key: "local_hash_embedding" } });
    expect(result.diagnostics.timings_ms.total).toBeGreaterThanOrEqual(0);
  });

  it("集合留空时执行全局搜索并把元数据过滤器下传", async () => {
    const ports = makeFakePorts([hit("1", "d1", "global result", 0.8, { category: "guide" })]);
    const searchSpy = vi.spyOn(ports.vectors, "search");
    const result = await makeService(ports).search({
      query: "global",
      search_mode: "vector",
      rerank: false,
      filters: { category: "guide" },
    });
    expect(result).toMatchObject({ collection_name: null, collection_scope: "all" });
    expect(result.diagnostics.filters_applied).toEqual(["category"]);
    const vectorInput = searchSpy.mock.calls[0]?.[0];
    expect(vectorInput).not.toHaveProperty("collection");
    expect(vectorInput).toMatchObject({ filters: { category: "guide" } });
  });

  it("rerank 开启时按 keyword 重排 hybrid 结果", async () => {
    const hits = [
      hit("1", "d1", "alpha vector space model baseline", 0.9),
      hit("2", "d2", "rag retrieval keyword overlap match", 0.4),
    ];
    const service = makeService(makeFakePorts(hits, null, [activeReranker("lexical")]));
    const result = await service.search({
      collection_name: "kb", query: "keyword overlap", top_k: 5, search_mode: "hybrid", rerank: true,
    });
    const ids = result.results.map((r) => r.document_id);
    expect(ids[0]).toBe("d2");
  });

  it("vector 模式同样支持 rerank", async () => {
    const hits = [
      hit("1", "d1", "vector only baseline", 0.9),
      hit("2", "d2", "keyword overlap match", 0.4),
    ];
    const service = makeService(makeFakePorts(hits, null, [activeReranker("lexical")]));
    const result = await service.search({
      collection_name: "kb", query: "keyword overlap", top_k: 5, search_mode: "vector", rerank: true,
    });
    expect(result).toMatchObject({ rerank_requested: true, rerank: true, rerank_mode: "lexical" });
    expect(result.results[0]).toMatchObject({ document_id: "d2", score_type: "rerank", rerank_rank: 1 });
  });

  it("vectorStore 无命中时 search 返回空候选", async () => {
    const service = makeService(makeFakePorts([]));
    const result = await service.search({ collection_name: "kb", query: "anything", top_k: 5 });
    expect(result.count).toBe(0);
  });

  it("listVectorizers 显示 driver 真维度(替占位 64)", async () => {
    const service = makeService(makeFakePorts([], 1536));
    await service.search({ collection_name: "kb", query: "probe", top_k: 5 });
    const active = (await service.listVectorizers()).find((vectorizer) => vectorizer.vectorizer_key === "local_hash_embedding");
    expect(active).toBeTruthy();
    expect(active?.vector_dimension).toBe(1536);
  });

  it("model reranker 成功返回 model", async () => {
    const hits = [hit("1", "d1", "first", 0.9)];
    const service = makeService(makeFakePorts(hits, null, [activeReranker("model")]), {
      modelAdapter: rerankProviderAdapter,
      rerankerFactory: stored => {
        expect(stored).toMatchObject({
          model_name: "provider-rerank-model",
          api_endpoint: "https://provider.example.test/v1/rerank",
          api_key: "provider-key",
        });
        return {
          rerank: async (_query, results) => ({
            results: results.map((result) => ({ ...result, rerank_score: 0.9 })),
            mode: "model",
          }),
        };
      },
    });
    await expect(service.search({ collection_name: "kb", query: "q", search_mode: "hybrid", rerank: true }))
      .resolves.toMatchObject({ rerank_mode: "model" });
  });

  it("model reranker 失败降级并标记结果", async () => {
    const hits = [hit("1", "d1", "query match", 0.9)];
    const service = makeService(makeFakePorts(hits, null, [activeReranker("model")]), {
      modelAdapter: rerankProviderAdapter,
      rerankerFactory: () => ({
        rerank: async () => { throw new Error("offline"); },
      }),
    });
    const output = await service.search({ collection_name: "kb", query: "query", search_mode: "hybrid", rerank: true });
    expect(output).toMatchObject({ rerank_mode: "degraded", rerank_error: "offline" });
    expect(output.results[0]).toMatchObject({ rerank_degraded: true });
  });

  it("请求 rerank 但没有配置时显式返回原因", async () => {
    const service = makeService(makeFakePorts([hit("1", "d1", "first", 0.9)]));
    await expect(service.search({ collection_name: "kb", query: "q", search_mode: "vector", rerank: true }))
      .resolves.toMatchObject({ rerank: false, rerank_mode: "none", rerank_error: "未配置可用的重排序器" });
  });

  it("active mode=none 且 rerank=true 时透传并返回 none", async () => {
    const hits = [hit("1", "d1", "first", 0.9)];
    const service = makeService(makeFakePorts(hits, null, [activeReranker("none")]));
    await expect(service.search({ collection_name: "kb", query: "q", search_mode: "hybrid", rerank: true }))
      .resolves.toMatchObject({ rerank_mode: "none" });
  });
});
