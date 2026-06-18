import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";

import type { IVectorStore, VectorSearchHit } from "../../src/contracts/vector-store/index.js";
import { ModelAdapterService } from "../../src/services/integrations/model-adapter-service.js";
import { VectorLibraryService } from "../../src/services/knowledge/vector-library-service.js";
import { FileIndexService } from "../../src/services/stores/file-index-service.js";

function makeDataRoot(): string {
  return path.join(os.tmpdir(), `rag-vec-search-${Math.random().toString(36).slice(2)}`);
}

/** 最小 IVectorStore stub:search 返回预设命中,其余 no-op。聚焦 service 编排(补 keyword/hybrid + rerank)。 */
function makeFakeDriver(hits: VectorSearchHit[]): IVectorStore {
  return {
    upsertRecords: async () => {},
    search: async () => hits,
    deleteDocument: async () => ({ deleted_chunks: 0 }),
    deleteCollection: async () => ({ deleted_chunks: 0 }),
    deleteByModel: async () => ({ deleted: 0 }),
    listCollections: async () => [],
    listDocuments: async () => [],
    countVectors: async () => 0,
    countVectorsForDocument: async () => 0,
    countChunks: async () => 0,
    health: async () => ({ status: "healthy", runtime: "mock", ann: true, collections_count: 0 }),
    close: () => {},
  } satisfies IVectorStore;
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
    const service = new VectorLibraryService(fileIndex, modelAdapter, {
      dbPath: ":memory:", dataRoot, vectorStore: makeFakeDriver(hits),
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
    const service = new VectorLibraryService(fileIndex, modelAdapter, {
      dbPath: ":memory:", dataRoot, vectorStore: makeFakeDriver(hits),
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

  it("vectorStore 未注入时降级到旧 hash 路径(空表返回空)", async () => {
    const dataRoot = makeDataRoot();
    const fileIndex = new FileIndexService({ dbPath: ":memory:", dataRoot });
    const modelAdapter = new ModelAdapterService({ providersConfigPath: "" });
    const service = new VectorLibraryService(fileIndex, modelAdapter, { dbPath: ":memory:", dataRoot });
    try {
      const result = (await service.search({ collection_name: "kb", query: "anything", top_k: 5 })) as { count: number };
      expect(result.count).toBe(0);
    } finally {
      service.close();
      fileIndex.close();
    }
  });
});