import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";

import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;
const tempRoots: string[] = [];

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  for (const root of tempRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows can hold SQLite handles briefly after close.
    }
  }
});

describe("vector library compatibility routes", () => {
  it("serves file-status from uploaded files and empty vectorizer config by default", async () => {
    app = await buildTestApp();

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/vector-library/files/upload",
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

  it("indexes uploaded files, migrates vectors, and deletes indexed file chunks", async () => {
    app = await buildTestApp();

    await createEmbeddingProvider();
    const created = await app.inject({
      method: "POST",
      url: "/api/vector-library/vectorizers",
      payload: {
        provider_key: "embedding_openai_proxy",
        model_name: "text-embedding-3-small",
      },
    });
    expect(created.statusCode).toBe(200);
    const vectorizerKey = created.json().data.vectorizer_key;

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/vector-library/files/upload",
      headers: multipartHeaders("boundary-vector-index"),
      payload: multipartBody(
        "boundary-vector-index",
        "files",
        "rag-notes.txt",
        "text/plain",
        "TypeScript vector migration indexes uploaded knowledge files for RAG search.",
      ),
    });
    expect(uploaded.statusCode).toBe(200);
    const file = uploaded.json().files[0];

    const indexFile = await app.inject({
      method: "POST",
      url: "/api/vector-library/index-file",
      payload: {
        collection: "documents",
        file_id: file.id,
        vectorizer_key: vectorizerKey,
      },
    });
    expect(indexFile.statusCode).toBe(200);
    expect(indexFile.json().data).toMatchObject({
      collection: "documents",
      file_id: file.id,
      vectorizer_key: vectorizerKey,
      indexed_chunks: 1,
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/vector-library/file-status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().data.files[0]).toMatchObject({
      file_id: file.id,
      chunk_count: 1,
      vectorizer_status: {
        [vectorizerKey]: "已索引",
      },
    });

    const target = await app.inject({
      method: "POST",
      url: "/api/vector-library/vectorizers",
      payload: {
        provider_key: "embedding_openai_proxy",
        model_name: "text-embedding-3-large",
      },
    });
    expect(target.statusCode).toBe(200);

    const migrate = await app.inject({
      method: "POST",
      url: "/api/vector-library/migrate",
      payload: {
        from_key: vectorizerKey,
        to_key: target.json().data.vectorizer_key,
      },
    });
    expect(migrate.statusCode).toBe(200);
    expect(migrate.json().data).toMatchObject({
      from_key: vectorizerKey,
      migrated_chunks: 1,
    });

    const deleteFile = await app.inject({
      method: "POST",
      url: "/api/vector-library/delete-file",
      payload: {
        collection: "documents",
        file_id: file.id,
      },
    });
    expect(deleteFile.statusCode).toBe(200);
    expect(deleteFile.json().data).toMatchObject({
      collection: "documents",
      document_id: file.id,
      deleted_chunks: 1,
    });
  });

  it("deleting a knowledge file cascades to purge its indexed vectors", async () => {
    app = await buildTestApp();

    await createEmbeddingProvider();
    const created = await app.inject({
      method: "POST",
      url: "/api/vector-library/vectorizers",
      payload: { provider_key: "embedding_openai_proxy", model_name: "text-embedding-3-small" },
    });
    expect(created.statusCode).toBe(200);
    const vectorizerKey = created.json().data.vectorizer_key;

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/vector-library/files/upload",
      headers: multipartHeaders("boundary-cascade"),
      payload: multipartBody(
        "boundary-cascade",
        "files",
        "cascade.txt",
        "text/plain",
        "cascade delete purges indexed vectors",
      ),
    });
    expect(uploaded.statusCode).toBe(200);
    const file = uploaded.json().files[0];

    const indexFile = await app.inject({
      method: "POST",
      url: "/api/vector-library/index-file",
      payload: { collection: "documents", file_id: file.id, vectorizer_key: vectorizerKey },
    });
    expect(indexFile.statusCode).toBe(200);
    expect(indexFile.json().data.indexed_chunks).toBe(1);

    // 删前:文件已索引,向量落在 documents collection
    const docsBefore = await app.inject({ method: "GET", url: "/api/vector/documents/documents" });
    expect(docsBefore.json().data.sample_ids).toContain(file.id);

    // 删知识库文件 → 联动清向量(跨 collection 按 document_id)
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/vector-library/files/${encodeURIComponent(file.id)}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ success: true, deleted_chunks: 1 });

    // 文件已删(kb_files 不再含)
    const fileList = await app.inject({ method: "GET", url: "/api/vector-library/files" });
    expect(fileList.json().files).toEqual([]);

    // 向量已删(documents collection 不再含该 document_id)
    const docsAfter = await app.inject({ method: "GET", url: "/api/vector/documents/documents" });
    expect(docsAfter.json().data.sample_ids).not.toContain(file.id);
  });

  it("indexing the same file under two vectorizers keeps both models' vectors", async () => {
    app = await buildTestApp();
    await createEmbeddingProvider();
    // 两个 vectorizer(不同 model_name → 不同 model_id)
    const vA = await app.inject({
      method: "POST",
      url: "/api/vector-library/vectorizers",
      payload: { provider_key: "embedding_openai_proxy", model_name: "text-embedding-3-small" },
    });
    const vB = await app.inject({
      method: "POST",
      url: "/api/vector-library/vectorizers",
      payload: { provider_key: "embedding_openai_proxy", model_name: "text-embedding-3-large" },
    });
    expect(vA.statusCode).toBe(200);
    expect(vB.statusCode).toBe(200);
    const keyA = vA.json().data.vectorizer_key;
    const keyB = vB.json().data.vectorizer_key;

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/vector-library/files/upload",
      headers: multipartHeaders("boundary-multi"),
      payload: multipartBody(
        "boundary-multi",
        "files",
        "multi-vectorizer.txt",
        "text/plain",
        "multi vectorizer indexing keeps both models vectors alive",
      ),
    });
    expect(uploaded.statusCode).toBe(200);
    const file = uploaded.json().files[0];

    // 先索引 A,再索引 B(关键:B 不应清掉 A 的向量)
    const iA = await app.inject({
      method: "POST",
      url: "/api/vector-library/index-file",
      payload: { collection: "documents", file_id: file.id, vectorizer_key: keyA },
    });
    expect(iA.statusCode).toBe(200);
    expect(iA.json().data.indexed_chunks).toBe(1);
    const iB = await app.inject({
      method: "POST",
      url: "/api/vector-library/index-file",
      payload: { collection: "documents", file_id: file.id, vectorizer_key: keyB },
    });
    expect(iB.statusCode).toBe(200);
    expect(iB.json().data.indexed_chunks).toBe(1);

    // 两个 vectorizer 都"已索引"——B 没清掉 A(修复证据);未修时 A 会被清成"未索引"
    const status = await app.inject({ method: "GET", url: "/api/vector-library/file-status" });
    expect(status.statusCode).toBe(200);
    const f = status.json().data.files.find((x: { file_id: string }) => x.file_id === file.id);
    expect(f.vectorizer_status[keyA]).toBe("已索引");
    expect(f.vectorizer_status[keyB]).toBe("已索引");
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
        status: "healthy",
        collections_count: 0,
      },
    });
  });

  it("indexes, searches, and deletes vector documents and collections", async () => {
    app = await buildTestApp();

    const index = await app.inject({
      method: "POST",
      url: "/api/vector/index",
      payload: {
        document_id: "doc-1",
        collection_name: "kb",
        text: "TypeScript backend migration includes vector search and RAG retrieval.",
        metadata: {
          source: "doc-1.md",
        },
      },
    });
    expect(index.statusCode).toBe(200);
    expect(index.json().data).toMatchObject({
      document_id: "doc-1",
      indexed_chunks: 1,
      collection_name: "kb",
    });

    const collections = await app.inject({
      method: "GET",
      url: "/api/vector/collections",
    });
    expect(collections.statusCode).toBe(200);
    expect(collections.json()).toMatchObject({
      success: true,
      count: 1,
      data: [
        {
          name: "kb",
          document_count: 1,
          chunk_count: 1,
        },
      ],
    });

    const search = await app.inject({
      method: "POST",
      url: "/api/vector/search",
      payload: {
        query: "RAG retrieval",
        collection_name: "kb",
        top_k: 5,
        search_mode: "hybrid",
      },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().data).toMatchObject({
      count: 1,
      collection_name: "kb",
      search_mode: "hybrid",
      results: [
        {
          document_id: "doc-1",
          collection: "kb",
        },
      ],
    });

    const deleteDocument = await app.inject({
      method: "DELETE",
      url: "/api/vector/documents/kb/doc-1",
    });
    expect(deleteDocument.statusCode).toBe(200);
    expect(deleteDocument.json().data.deleted_chunks).toBe(1);

    await app.inject({
      method: "POST",
      url: "/api/vector/index",
      payload: {
        document_id: "doc-2",
        collection_name: "kb",
        text: "Collection deletion removes all chunks.",
      },
    });
    const deleteCollection = await app.inject({
      method: "DELETE",
      url: "/api/vector/collections/kb",
    });
    expect(deleteCollection.statusCode).toBe(200);
    expect(deleteCollection.json().data).toMatchObject({
      collection: "kb",
      deleted_chunks: 1,
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
