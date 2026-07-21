import { describe, expect, it, vi } from "vitest";

import { LocalAsyncKnowledgeConfigAdapter } from "../../../../src/adapters/local/knowledge/local-async-knowledge-config-adapter.js";
import type {
  IKnowledgeConfig,
  StoredReranker,
  StoredVectorizer,
} from "../../../../src/contracts/vector-store/index.js";

const vectorizer: StoredVectorizer = {
  model_id: 7,
  vectorizer_key: "embed",
  provider_key: "local",
  provider_type: null,
  model_name: "hash-64",
  distance_metric: "cosine",
  created_at: "2026-01-01T00:00:00.000Z",
  vector_dimension: null,
  is_active: true,
};

const reranker: StoredReranker = {
  reranker_key: "bm25",
  mode: "lexical",
  provider_key: "local",
  provider_type: null,
  model_name: "bm25",
  api_endpoint: "",
  api_key: null,
  created_at: "2026-01-01T00:00:00.000Z",
  is_active: true,
};

function makeConfig(): IKnowledgeConfig {
  return {
    listVectorizers: vi.fn(() => [vectorizer]),
    getVectorizerByKey: vi.fn((key) => key === vectorizer.vectorizer_key ? vectorizer : null),
    getVectorizerByModelId: vi.fn((modelId) => modelId === vectorizer.model_id ? vectorizer : null),
    createVectorizer: vi.fn(() => vectorizer),
    deleteVectorizer: vi.fn(() => ({ next_active_key: null })),
    activateVectorizer: vi.fn(),
    listRerankers: vi.fn(() => [reranker]),
    getReranker: vi.fn((key) => key === reranker.reranker_key ? reranker : null),
    createReranker: vi.fn(() => reranker),
    deleteReranker: vi.fn(() => ({ next_active_key: null })),
    activateReranker: vi.fn(),
  };
}

describe("Local async knowledge config adapter", () => {
  it("delegates configuration operations without forwarding the tenant id", async () => {
    const config = makeConfig();
    const adapter = new LocalAsyncKnowledgeConfigAdapter(config);

    await expect(adapter.listVectorizers("tenant-a")).resolves.toEqual([vectorizer]);
    await expect(adapter.getVectorizerByKey("tenant-a", "embed")).resolves.toBe(vectorizer);
    await adapter.activateVectorizer("tenant-a", "embed");
    await expect(adapter.deleteVectorizer("tenant-a", "embed")).resolves.toEqual({ next_active_key: null });
    await expect(adapter.listRerankers("tenant-a")).resolves.toEqual([reranker]);
    await adapter.activateReranker("tenant-a", "bm25");

    expect(config.getVectorizerByKey).toHaveBeenCalledWith("embed");
    expect(config.activateVectorizer).toHaveBeenCalledWith("embed");
    expect(config.deleteVectorizer).toHaveBeenCalledWith("embed");
    expect(config.activateReranker).toHaveBeenCalledWith("bm25");
  });

  it("validates dimensions while leaving persistence to the Local vector upsert", async () => {
    const config = makeConfig();
    const adapter = new LocalAsyncKnowledgeConfigAdapter(config);

    await expect(adapter.setVectorDimension("tenant-a", "embed", 64)).resolves.toBeUndefined();
    await expect(adapter.setVectorDimension("tenant-a", "embed", 0)).rejects.toThrow("positive integer");
    await expect(adapter.setVectorDimension("tenant-a", "missing", 64)).rejects.toThrow("vectorizer not found");
  });
});
