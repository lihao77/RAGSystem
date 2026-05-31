import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("vector library compatibility routes", () => {
  it("serves file-status from uploaded files and empty vectorizer config by default", async () => {
    app = await buildTestApp();

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/files/upload",
      headers: multipartHeaders("boundary-vector"),
      payload: multipartBody("boundary-vector", "files", "knowledge.txt", "text/plain", "hello vector"),
    });
    expect(uploaded.statusCode).toBe(200);
    const file = uploaded.json().files[0];

    const status = await app.inject({
      method: "GET",
      url: "/api/vector-library/file-status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      success: true,
      data: {
        vectorizers: [],
        files: [
          {
            file_id: file.id,
            file_name: "knowledge.txt",
            collection: "documents",
            chunk_count: 0,
            vectorizer_status: {},
          },
        ],
      },
    });
  });

  it("supports in-memory vectorizer config management", async () => {
    app = await buildTestApp();

    await app.inject({
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

    const created = await app.inject({
      method: "POST",
      url: "/api/vector-library/vectorizers",
      payload: {
        provider_key: "embedding_openai_proxy",
        model_name: "text-embedding-3-small",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      success: true,
      data: {
        vectorizer_key: "embedding_openai_proxy_text-embedding-3-small",
        vector_dimension: null,
        model_id: 1,
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/vector-library/vectorizers",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toMatchObject([
      {
        vectorizer_key: "embedding_openai_proxy_text-embedding-3-small",
        provider_key: "embedding_openai_proxy",
        model_name: "text-embedding-3-small",
        distance_metric: "cosine",
        is_active: true,
        provider_available: true,
        vector_dimension: null,
        vector_count: 0,
        model_id: 1,
      },
    ]);

    const docs = await app.inject({
      method: "GET",
      url: "/api/vector-library/vectorizers/embedding_openai_proxy_text-embedding-3-small/docs",
    });
    expect(docs.statusCode).toBe(200);
    expect(docs.json()).toMatchObject({
      success: true,
      data: [],
    });

    const activated = await app.inject({
      method: "POST",
      url: "/api/vector-library/vectorizers/embedding_openai_proxy_text-embedding-3-small/activate",
      payload: {},
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().data.active_vectorizer_key).toBe("embedding_openai_proxy_text-embedding-3-small");

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/vector-library/vectorizers/embedding_openai_proxy_text-embedding-3-small",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.deleted_vectorizer_key).toBe("embedding_openai_proxy_text-embedding-3-small");
  });

  it("supports in-memory reranker config management", async () => {
    app = await buildTestApp();

    const lexical = await app.inject({
      method: "POST",
      url: "/api/vector-library/rerankers",
      payload: {
        mode: "lexical",
      },
    });
    expect(lexical.statusCode).toBe(200);
    expect(lexical.json().data.reranker_key).toBe("bm25_local");

    const model = await app.inject({
      method: "POST",
      url: "/api/vector-library/rerankers",
      payload: {
        mode: "model",
        provider_key: "ranker_rerank_api",
        model_name: "jina-reranker-v2-base-multilingual",
        api_endpoint: "https://api.example.test/rerank",
        api_key: "rk-test",
      },
    });
    expect(model.statusCode).toBe(200);
    expect(model.json().data.reranker_key).toBe("ranker_rerank_api_jina-reranker-v2-base-multilingual");

    const listed = await app.inject({
      method: "GET",
      url: "/api/vector-library/rerankers",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toMatchObject([
      {
        reranker_key: "bm25_local",
        mode: "lexical",
        is_active: true,
      },
      {
        reranker_key: "ranker_rerank_api_jina-reranker-v2-base-multilingual",
        mode: "model",
        provider_key: "ranker_rerank_api",
        model_name: "jina-reranker-v2-base-multilingual",
        api_endpoint: "https://api.example.test/rerank",
        is_active: false,
      },
    ]);

    const getOne = await app.inject({
      method: "GET",
      url: "/api/vector-library/rerankers/ranker_rerank_api_jina-reranker-v2-base-multilingual",
    });
    expect(getOne.statusCode).toBe(200);
    expect(getOne.json().data.mode).toBe("model");

    const activated = await app.inject({
      method: "POST",
      url: "/api/vector-library/rerankers/ranker_rerank_api_jina-reranker-v2-base-multilingual/activate",
      payload: {},
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().data.active_reranker_key).toBe(
      "ranker_rerank_api_jina-reranker-v2-base-multilingual",
    );

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/vector-library/rerankers/bm25_local",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().data.deleted_reranker_key).toBe("bm25_local");
  });

  it("keeps real vector runtime effects as explicit not-migrated boundaries", async () => {
    app = await buildTestApp();

    const indexFile = await app.inject({
      method: "POST",
      url: "/api/vector-library/index-file",
      payload: {
        collection: "documents",
        file_id: "file-1",
        vectorizer_key: "vectorizer-1",
      },
    });
    expect(indexFile.statusCode).toBe(501);
    expect(indexFile.json()).toMatchObject({
      success: false,
      code: "not_migrated",
    });

    const deleteFile = await app.inject({
      method: "POST",
      url: "/api/vector-library/delete-file",
      payload: {
        collection: "documents",
        file_id: "file-1",
      },
    });
    expect(deleteFile.statusCode).toBe(501);

    const migrate = await app.inject({
      method: "POST",
      url: "/api/vector-library/migrate",
      payload: {
        from_key: "old",
        to_key: "new",
      },
    });
    expect(migrate.statusCode).toBe(501);
  });
});

describe("vector management compatibility routes", () => {
  it("serves empty management reads and vector health status", async () => {
    app = await buildTestApp();

    const collections = await app.inject({
      method: "GET",
      url: "/api/vector/collections",
    });
    expect(collections.statusCode).toBe(200);
    expect(collections.json()).toEqual({
      success: true,
      data: [],
      count: 0,
    });

    const documents = await app.inject({
      method: "GET",
      url: "/api/vector/documents/documents",
    });
    expect(documents.statusCode).toBe(200);
    expect(documents.json()).toMatchObject({
      success: true,
      data: {
        collection_name: "documents",
        total_chunks: 0,
        sample_ids: [],
      },
    });

    const health = await app.inject({
      method: "GET",
      url: "/api/vector/health",
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      success: true,
      data: {
        status: "unavailable",
        runtime: "not_migrated",
        collections_count: 0,
      },
    });
  });

  it("keeps vector search and document indexing as explicit not-migrated boundaries", async () => {
    app = await buildTestApp();

    const search = await app.inject({
      method: "POST",
      url: "/api/vector/search",
      payload: {
        query: "hello",
        top_k: 5,
        search_mode: "hybrid",
      },
    });
    expect(search.statusCode).toBe(501);
    expect(search.json()).toMatchObject({
      success: false,
      code: "not_migrated",
    });

    const index = await app.inject({
      method: "POST",
      url: "/api/vector/index",
      payload: {
        document_id: "doc-1",
        text: "hello",
      },
    });
    expect(index.statusCode).toBe(501);

    const deleteDocument = await app.inject({
      method: "DELETE",
      url: "/api/vector/documents/documents/doc-1",
    });
    expect(deleteDocument.statusCode).toBe(501);
  });
});

function multipartHeaders(boundary: string): Record<string, string> {
  return {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
}

function multipartBody(
  boundary: string,
  fieldName: string,
  filename: string,
  contentType: string,
  content: string,
): string {
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
