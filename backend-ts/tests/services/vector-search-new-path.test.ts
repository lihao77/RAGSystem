import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

import type { IKnowledgeConfig, IVectorStore, VectorSearchHit } from "../../src/contracts/vector-store/index.js";
import { ModelAdapterService } from "../../src/services/integrations/model-adapter-service.js";
import { VectorLibraryService } from "../../src/services/knowledge/vector-library-service.js";
import { FileIndexService } from "../../src/services/stores/file-index-service.js";

function makeDataRoot(): string {
  return path.join(os.tmpdir(), `rag-vec-search-${Math.random().toString(36).slice(2)}`);
}

/**
 * 最小 IVectorStore & IKnowledgeConfig stub:search 返回预设命中,配置面维护内存态。
 * 聚焦 service 编排(补 keyword/hybrid + rerank)——driver 配置面由 driver 单元测试覆盖。
 */
function makeFakeDriver(hits: VectorSearchHit[], dimension: number | null = null): IVectorStore & IKnowledgeConfig {
  const vectorizers: Array<ReturnType<IKnowledgeConfig["createVectorizer"]>> = [];
  return {
    upsertRecords: async () => {},
    search: async () => hits,
    deleteDocument: async () => ({ deleted_chunks: 0 }),
    deleteCollection: async () => ({ deleted_chunks: 0 }),
    deleteByModel: async () => ({ deleted: 0 }),
    listCollections: async () => [],
    listDocuments: async () => [],
    countVectors: async () => 0,
    countVectorsByModel: async () => [],
    countVectorsForDocument: async () => 0,
    countChunks: async () => 0,
    listChunks: async () => [],
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
    listRerankers: () => [],
    getReranker: () => null,
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
  } satisfies IVectorStore & IKnowledgeConfig;
}

/** 空 knowledgeConfig stub:用于无 driver 注入场景(service 应优雅降级)。 */
function emptyKnowledgeConfig(): IKnowledgeConfig {
  return {
    listVectorizers: () => [],
    getVectorizerByKey: () => null,
    getVectorizerByModelId: () => null,
    createVectorizer: (input) => ({
      model_id: 1,
      vectorizer_key: input.vectorizer_key,
      provider_key: input.provider_key,
      provider_type: input.provider_type,
      model_name: input.model_name,
      distance_metric: input.distance_metric,
      created_at: new Date().toISOString(),
      vector_dimension: null,
      is_active: true,
    }),
    deleteVectorizer: () => ({ next_active_key: null }),
    activateVectorizer: () => {},
    listRerankers: () => [],
    getReranker: () => null,
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
  };
}

describe("VectorLibraryService search 新路径(driver 召回 + scoring 重排)", () => {
  it("driver 召回后补 keyword/hybrid 并按 hybrid 排序", async () => {
    const dataRoot = makeDataRoot();
    const fileIndex = new FileIndexService({ dbPath: ":memory:", dataRoot });
    const modelAdapter = new ModelAdapterService({ providersConfigPath: "" });
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
    const fakeDriver = makeFakeDriver(hits);
    const service = new VectorLibraryService(fileIndex, modelAdapter, {
      vectorStore: fakeDriver, knowledgeConfig: fakeDriver,
    });
    try {
      const result = (await service.search({
        collection_name: "kb", query: "RAG retrieval backend", top_k: 5, search_mode: "hybrid",
      })) as { results: Array<Record<string, unknown>>; count: number };
      expect(result.count).toBe(2);
      const first = result.results[0]!;
      expect(first.document_id).toBe("d1");
      expect(Number(first.vector_score)).toBeCloseTo(0.8, 4);
      expect(Number(first.keyword_score)).toBeGreaterThan(0);
      expect(Number(first.hybrid_score)).toBeGreaterThan(Number(first.vector_score) * 0.7);
    } finally {
      service.close();
      fileIndex.close();
    }
  });

  it("rerank 开启时按 keyword 重排 hybrid 结果", async () => {
    const dataRoot = makeDataRoot();
    const fileIndex = new FileIndexService({ dbPath: ":memory:", dataRoot });
    const modelAdapter = new ModelAdapterService({ providersConfigPath: "" });
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
    const fakeDriver = makeFakeDriver(hits);
    const service = new VectorLibraryService(fileIndex, modelAdapter, {
      vectorStore: fakeDriver, knowledgeConfig: fakeDriver,
    });
    try {
      const result = (await service.search({
        collection_name: "kb", query: "keyword overlap", top_k: 5, search_mode: "hybrid", rerank: true,
      })) as { results: Array<Record<string, unknown>> };
      const ids = result.results.map((r) => r.document_id);
      // lexicalRerank 按 keyword 重排:d2 含 query 关键词 → 排前
      expect(ids[0]).toBe("d2");
    } finally {
      service.close();
      fileIndex.close();
    }
  });

  it("vectorStore 未注入时 search 返回空候选", async () => {
    const dataRoot = makeDataRoot();
    const fileIndex = new FileIndexService({ dbPath: ":memory:", dataRoot });
    const modelAdapter = new ModelAdapterService({ providersConfigPath: "" });
    const service = new VectorLibraryService(fileIndex, modelAdapter, { knowledgeConfig: emptyKnowledgeConfig() });
    try {
      const result = (await service.search({ collection_name: "kb", query: "anything", top_k: 5 })) as { count: number };
      expect(result.count).toBe(0);
    } finally {
      service.close();
      fileIndex.close();
    }
  });

  it("listVectorizers 显示 driver 真维度(替占位 64)", async () => {
    const dataRoot = makeDataRoot();
    const fileIndex = new FileIndexService({ dbPath: ":memory:", dataRoot });
    const modelAdapter = new ModelAdapterService({ providersConfigPath: "" });
    const fakeDriver = makeFakeDriver([], 1536);
    const service = new VectorLibraryService(fileIndex, modelAdapter, {
      vectorStore: fakeDriver, knowledgeConfig: fakeDriver,
    });
    try {
      // search 触发 resolveActiveVectorizer 创建 local_hash_embedding(model_id=1)
      await service.search({ collection_name: "kb", query: "probe", top_k: 5 });
      const active = (await service.listVectorizers()).find((vectorizer) => vectorizer.vectorizer_key === "local_hash_embedding");
      expect(active).toBeTruthy();
      // toVectorizerConfig 用 driver.getDimension(1)=1536,非 addVectorizer 占位的 64
      expect(active?.vector_dimension).toBe(1536);
    } finally {
      service.close();
      fileIndex.close();
    }
  });
});