import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp, buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("embedding model compatibility routes", () => {
  it("uses the deployment-neutral knowledge application instead of Local runtime capabilities", async () => {
    const knowledge = {
      listVectorizers: vi.fn().mockResolvedValue([{
        model_id: 7, vectorizer_key: "embed", provider_key: "local", provider_type: null, model_name: "hash-64",
        distance_metric: "cosine", created_at: "2026-01-01T00:00:00Z", is_active: true, provider_available: true,
        vector_dimension: 64, vector_count: 2,
      }]),
      activateVectorizer: vi.fn().mockResolvedValue({ active_vectorizer_key: "embed" }),
      deleteVectorizer: vi.fn().mockResolvedValue({ deleted_vectorizer_key: "embed" }),
      getModelStats: vi.fn().mockResolvedValue({ vector_count: 2, storage_size_mb: 0, collections: { docs: 2 } }),
      getSyncStatus: vi.fn().mockResolvedValue([]),
      syncModel: vi.fn().mockResolvedValue({ model_id: 7, collection: "docs", synced_documents: 0 }),
    };
    const harness = await buildTestHarness({ resolveKnowledgeApplication: () => knowledge as never });
    app = harness.app;

    const models = await app.inject({ method: "GET", url: "/api/embedding-models/models" });
    expect(models.statusCode).toBe(200);
    expect(models.json().models[0]).toMatchObject({ id: 7, vectorizer_key: "embed", stats: { vector_count: 2 } });

    const activated = await app.inject({ method: "POST", url: "/api/embedding-models/models/7/activate" });
    expect(activated.statusCode).toBe(200);
    expect(knowledge.activateVectorizer).toHaveBeenCalledWith("embed");
  });

  it("serves an empty model list and sync status by default", async () => {
    app = await buildTestApp();

    const models = await app.inject({
      method: "GET",
      url: "/api/embedding-models/models",
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual({
      success: true,
      models: [],
    });

    const syncStatus = await app.inject({
      method: "GET",
      url: "/api/embedding-models/models/sync-status?collection=documents",
    });
    expect(syncStatus.statusCode).toBe(200);
    expect(syncStatus.json()).toEqual({
      success: true,
      collection: "documents",
      sync_status: [],
    });
  });

  it("derives model list, stats, activation, and deletion from vectorizers", async () => {
    app = await buildTestApp();

    await createEmbeddingProvider();
    const created = await app.inject({
      method: "POST",
      url: "/api/knowledge-bases/vectorizers",
      payload: {
        provider_key: "embedding_openai_proxy",
        model_name: "text-embedding-3-small",
      },
    });
    expect(created.statusCode).toBe(200);

    const models = await app.inject({
      method: "GET",
      url: "/api/embedding-models/models",
    });
    expect(models.statusCode).toBe(200);
    expect(models.json().models).toMatchObject([
      {
        id: 1,
        model_key: "embedding_openai_proxy_text-embedding-3-small_0",
        provider: "embedding_openai_proxy",
        model_name: "text-embedding-3-small",
        vector_dimension: 0,
        distance_metric: "cosine",
        is_active: true,
        api_endpoint: null,
        vectorizer_key: "embedding_openai_proxy_text-embedding-3-small",
        stats: {
          model_id: 1,
          vector_count: 0,
          storage_size_mb: 0,
          collections: {},
        },
      },
    ]);

    const stats = await app.inject({
      method: "GET",
      url: "/api/embedding-models/models/1/stats?collection=documents",
    });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().stats).toMatchObject({
      model_id: 1,
      model_key: "embedding_openai_proxy_text-embedding-3-small_0",
      vector_count: 0,
      collections: {},
    });

    const activated = await app.inject({
      method: "POST",
      url: "/api/embedding-models/models/1/activate",
      payload: {},
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toEqual({
      success: true,
      message: "模型 1 已激活",
    });

    const deleteActive = await app.inject({
      method: "DELETE",
      url: "/api/embedding-models/models/1",
    });
    expect(deleteActive.statusCode).toBe(400);
    expect(deleteActive.json()).toMatchObject({
      success: false,
      code: "invalid_request",
      message: "删除失败，请检查日志",
    });

    const forceDelete = await app.inject({
      method: "DELETE",
      url: "/api/embedding-models/models/1?force=true",
    });
    expect(forceDelete.statusCode).toBe(200);
    expect(forceDelete.json()).toEqual({
      success: true,
      message: "模型 1 已删除",
    });

    const afterDelete = await app.inject({
      method: "GET",
      url: "/api/embedding-models/models",
    });
    expect(afterDelete.json().models).toEqual([]);
  });

  it("syncs missing vectors for an embedding model", async () => {
    app = await buildTestApp();

    await createEmbeddingProvider();
    const created = await app.inject({
      method: "POST",
      url: "/api/knowledge-bases/vectorizers",
      payload: {
        provider_key: "embedding_openai_proxy",
        model_name: "text-embedding-3-small",
      },
    });
    expect(created.statusCode).toBe(200);

    const indexed = await app.inject({
      method: "POST",
      url: "/api/knowledge-bases/index",
      payload: {
        collection_name: "documents",
        document_id: "sync-doc",
        text: "Embedding sync indexes pending document chunks.",
      },
    });
    expect(indexed.statusCode).toBe(200);

    const target = await app.inject({
      method: "POST",
      url: "/api/knowledge-bases/vectorizers",
      payload: {
        provider_key: "embedding_openai_proxy",
        model_name: "text-embedding-3-large",
      },
    });
    expect(target.statusCode).toBe(200);

    const sync = await app.inject({
      method: "POST",
      url: "/api/embedding-models/models/2/sync",
      payload: {
        collection: "documents",
        batch_size: 50,
      },
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({
      success: true,
      model_id: 2,
      collection: "documents",
      synced_documents: 1,
    });

    const syncStatus = await app.inject({
      method: "GET",
      url: "/api/embedding-models/models/sync-status?collection=documents",
    });
    expect(syncStatus.statusCode).toBe(200);
    expect(syncStatus.json().sync_status).toMatchObject([
      {
        model_id: 1,
        synced_documents: 1,
        pending_documents: 0,
        sync_percentage: 100,
      },
      {
        model_id: 2,
        synced_documents: 1,
        pending_documents: 0,
        sync_percentage: 100,
      },
    ]);
  });

  it("validates bad model ids and missing models", async () => {
    app = await buildTestApp();

    const badId = await app.inject({
      method: "GET",
      url: "/api/embedding-models/models/not-a-number/stats",
    });
    expect(badId.statusCode).toBe(400);
    expect(badId.json()).toMatchObject({
      success: false,
      code: "invalid_request",
    });

    const missingActivate = await app.inject({
      method: "POST",
      url: "/api/embedding-models/models/999/activate",
      payload: {},
    });
    expect(missingActivate.statusCode).toBe(200);
    expect(missingActivate.json()).toMatchObject({
      success: true,
      message: "模型 999 已激活",
    });

    const missingStats = await app.inject({
      method: "GET",
      url: "/api/embedding-models/models/999/stats",
    });
    expect(missingStats.statusCode).toBe(200);
    expect(missingStats.json()).toEqual({
      success: true,
      stats: {},
    });
  });
});

async function createEmbeddingProvider(): Promise<void> {
  if (!app) {
    throw new Error("test app not initialized");
  }
  const provider = await app.inject({
    method: "POST",
    url: "/api/model-adapter/providers",
    payload: {
      name: "Embedding",
      provider_type: "openai_proxy",
      api_key: "sk-test",
      model_map: {
        embedding: "text-embedding-3-small",
      },
    },
  });
  expect(provider.statusCode).toBe(200);
}
