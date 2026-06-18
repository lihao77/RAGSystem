import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { buildTestApp } from "../helpers/app.js";
import { FileIndexService } from "../../src/services/stores/file-index-service.js";
import { ModelAdapterService } from "../../src/services/integrations/model-adapter-service.js";
import { VectorLibraryService } from "../../src/services/knowledge/vector-library-service.js";

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
      url: "/api/files/upload",
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
});

describe("vector management compatibility routes", () => {
  it("migrates legacy vector document schema on startup", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-vector-"));
    tempRoots.push(root);
    const dbPath = path.join(root, "legacy.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE documents (
        id TEXT NOT NULL,
        collection TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        vector_sync_status TEXT DEFAULT '{}',
        last_vector_sync TIMESTAMP,
        PRIMARY KEY (id, collection)
      );
      CREATE TABLE vectorizers (
        model_id INTEGER PRIMARY KEY AUTOINCREMENT,
        vectorizer_key TEXT NOT NULL UNIQUE,
        provider_key TEXT NOT NULL,
        provider_type TEXT,
        model_name TEXT NOT NULL,
        distance_metric TEXT NOT NULL,
        created_at TEXT NOT NULL,
        vector_dimension INTEGER,
        vector_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.prepare(
      `
        INSERT INTO vectorizers
        (model_id, vectorizer_key, provider_key, provider_type, model_name, distance_metric, created_at, vector_dimension, vector_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    ).run(1, "legacy_vectorizer", "local", "local", "hash", "cosine", new Date().toISOString(), 64, 1);
    db.prepare("INSERT INTO documents (id, collection, content, metadata) VALUES (?, ?, ?, ?)").run(
      "legacy-doc",
      "kb",
      "Legacy vector schema should migrate without startup failure.",
      JSON.stringify({ source: "legacy" }),
    );
    db.close();

    const fileIndex = new FileIndexService({ dbPath, dataRoot: root });
    const modelAdapter = new ModelAdapterService({ dataRoot: root, providersConfigPath: "" });
    const service = new VectorLibraryService(fileIndex, modelAdapter, { dbPath, dataRoot: root });
    try {
      // 5h-2:document_vectors 表 + hash 降级已删(driver 唯一源);此处仅验 documents 旧 schema→新 schema 迁移不崩溃。
      expect(service.listDocuments("kb")).toMatchObject({
        collection_name: "kb",
        total_chunks: 1,
        sample_ids: ["legacy-doc"],
      });
    } finally {
      service.close();
      fileIndex.close();
    }
  });

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
        runtime: "local",
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
      chunk_count: 1,
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

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

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
