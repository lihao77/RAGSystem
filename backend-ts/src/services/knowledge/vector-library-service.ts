import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import YAML from "yaml";

import type {
  DeleteIndexedFileRequest,
  FileStatusVectorizer,
  GenericVectorRequest,
  IndexFileRequest,
  RerankerConfig,
  RerankerCreate,
  SearchVectorsRequest,
  VectorFileStatus,
  VectorFileStatusResponse,
  VectorizerConfig,
  VectorizerCreate,
} from "../../contracts/vector-library.js";
import type { FileIndexService } from "../stores/file-index-service.js";
import type { ModelAdapterService } from "../integrations/model-adapter-service.js";

export class VectorLibraryServiceError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "VectorLibraryServiceError";
    this.statusCode = statusCode;
  }
}

export interface VectorSearchResult {
  id: string;
  doc_id: string;
  document_id: string;
  collection: string;
  text: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
  similarity: number;
  keyword_score: number;
  vector_score: number;
  hybrid_score: number;
  rerank_score?: number;
}

export class VectorLibraryService {
  private readonly db: import("node:sqlite").DatabaseSync;
  private readonly dataRoot: string;
  private readonly vectorizersConfigPath: string;
  private readonly rerankersConfigPath: string;
  private activeVectorizerKey: string | null = null;
  private activeRerankerKey: string | null = null;

  constructor(
    private readonly fileIndex: FileIndexService,
    private readonly modelAdapter: ModelAdapterService,
    options: { dbPath?: string | undefined; dataRoot?: string | undefined } = {},
  ) {
    this.dataRoot = path.resolve(options.dataRoot?.trim() || path.join(os.homedir(), ".ragsystem"));
    this.vectorizersConfigPath = path.join(this.dataRoot, "config", "vector_store", "vectorizers.yaml");
    this.rerankersConfigPath = path.join(this.dataRoot, "config", "vector_store", "rerankers.yaml");
    const dbPath = options.dbPath ?? ":memory:";
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.initDatabase();
    this.activeVectorizerKey = this.readSetting("active_vectorizer_key");
    this.activeRerankerKey = this.readSetting("active_reranker_key");
  }

  close(): void {
    this.db.close();
  }

  fileStatus(): VectorFileStatusResponse {
    const vectorizers = this.listFileStatusVectorizers();
    const files = this.listSharedDocumentFileStatuses(vectorizers);
    if (files !== null) {
      return { files, vectorizers };
    }
    return {
      files: this.fileIndex
        .list({ scopeType: "global", scopeId: null })
        .map((file): VectorFileStatus => {
          const collection = this.defaultCollectionForFile(file.id);
          const chunkCount = this.countChunksForDocument(collection, file.id);
          const status = Object.fromEntries(
            vectorizers.map((vectorizer) => [
              vectorizer.vectorizer_key,
              this.countVectorsForDocument(collection, file.id, vectorizer.model_id) >= chunkCount && chunkCount > 0
                ? "已索引"
                : "未索引",
            ]),
          ) as Record<string, "已索引" | "未索引">;
          return {
            file_name: file.original_name,
            file_id: file.id,
            collection,
            chunk_count: chunkCount,
            vectorizer_status: status,
            uploaded_at: file.uploaded_at,
            size: file.size,
            mime: file.mime,
          };
        }),
      vectorizers,
    };
  }

  listVectorizers(): VectorizerConfig[] {
    const shared = this.listSharedVectorizers();
    if (shared !== null) {
      return shared;
    }
    const rows = this.db
      .prepare("SELECT * FROM vectorizers ORDER BY model_id ASC")
      .all() as unknown as StoredVectorizer[];
    return rows.map((vectorizer) => this.toVectorizerConfig(vectorizer));
  }

  addVectorizer(input: VectorizerCreate): Pick<VectorizerConfig, "vectorizer_key" | "vector_dimension" | "model_id"> {
    const providerKey = input.provider_key.trim();
    const modelName = input.model_name.trim();
    if (!this.modelAdapter.hasProvider(providerKey)) {
      throw new VectorLibraryServiceError(`向量化器引用的 Provider 不存在: ${providerKey}`, 400);
    }

    const key = input.vectorizer_key?.trim() || normalizeVectorizerKey(providerKey, modelName);
    const existing = this.getStoredVectorizer(key);
    if (existing) {
      throw new VectorLibraryServiceError(`向量化器键已存在: ${key}`, 400);
    }

    const now = new Date().toISOString();
    const dimension = LOCAL_EMBEDDING_DIMENSION;
    this.db
      .prepare(
        `
          INSERT INTO vectorizers
          (vectorizer_key, provider_key, provider_type, model_name, distance_metric,
           created_at, vector_dimension, vector_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        key,
        providerKey,
        normalizeNullableString(input.provider_type),
        modelName,
        input.distance_metric || "cosine",
        now,
        dimension,
        0,
      );
    const created = this.getStoredVectorizer(key);
    if (!created) {
      throw new VectorLibraryServiceError(`向量化器创建失败: ${key}`, 500);
    }
    if (!this.activeVectorizerKey) {
      this.activeVectorizerKey = key;
      this.writeSetting("active_vectorizer_key", key);
    }
    return {
      vectorizer_key: key,
      vector_dimension: dimension,
      model_id: created.model_id,
    };
  }

  activateVectorizer(key: string): { active_vectorizer_key: string } {
    if (!this.getStoredVectorizer(key)) {
      throw new VectorLibraryServiceError(`向量化器不存在: ${key}`, 404);
    }
    this.activeVectorizerKey = key;
    this.writeSetting("active_vectorizer_key", key);
    return { active_vectorizer_key: key };
  }

  deleteVectorizer(key: string): { deleted_vectorizer_key: string } {
    const vectorizer = this.getStoredVectorizer(key);
    if (!vectorizer) {
      throw new VectorLibraryServiceError(`向量化器不存在: ${key}`, 404);
    }
    this.db.prepare("DELETE FROM document_vectors WHERE model_id = ?").run(vectorizer.model_id);
    this.db.prepare("DELETE FROM vectorizers WHERE vectorizer_key = ?").run(key);
    this.refreshVectorCounts();
    if (this.activeVectorizerKey === key) {
      const next = this.db.prepare("SELECT vectorizer_key FROM vectorizers ORDER BY model_id ASC LIMIT 1").get() as
        | { vectorizer_key: string }
        | undefined;
      this.activeVectorizerKey = next?.vectorizer_key ?? null;
      this.writeSetting("active_vectorizer_key", this.activeVectorizerKey);
    }
    return { deleted_vectorizer_key: key };
  }

  listDocsByVectorizer(key: string): Array<Record<string, unknown>> {
    const vectorizer = this.getStoredVectorizer(key);
    if (!vectorizer) {
      throw new VectorLibraryServiceError(`向量化器不存在或未在 DB 注册: ${key}`, 404);
    }
    return this.db
      .prepare(
        `
          SELECT d.document_id, d.collection, COUNT(v.id) AS vector_count, MIN(d.metadata) AS metadata
          FROM documents d
          JOIN document_vectors v ON v.doc_id = d.id AND v.model_id = ?
          GROUP BY d.collection, d.document_id
          ORDER BY d.collection, d.document_id
        `,
      )
      .all(vectorizer.model_id) as Array<Record<string, unknown>>;
  }

  indexFile(input: IndexFileRequest): Record<string, unknown> {
    const collection = input.collection.trim();
    const fileId = input.file_id.trim();
    const vectorizer = this.getStoredVectorizer(input.vectorizer_key.trim());
    if (!vectorizer) {
      throw new VectorLibraryServiceError(`向量化器不存在: ${input.vectorizer_key}`, 404);
    }
    const file = this.fileIndex.get(fileId, "global", null);
    if (!file) {
      throw new VectorLibraryServiceError(`文件不存在: ${fileId}`, 404);
    }
    if (!fs.existsSync(file.stored_path)) {
      throw new VectorLibraryServiceError(`文件路径无效: ${file.stored_path}`, 404);
    }
    const text = readUtf8File(file.stored_path);
    const result = this.indexTextDocument({
      collection,
      documentId: file.id,
      text,
      metadata: {
        source: file.original_name,
        source_file: file.original_name,
        file_id: file.id,
        original_filename: file.original_name,
        mime: file.mime,
      },
      vectorizer,
      chunkSize: readPositiveInteger((input as Record<string, unknown>).chunk_size, 500),
      overlap: readNonNegativeInteger((input as Record<string, unknown>).overlap, 50),
    });
    return {
      collection,
      file_id: file.id,
      vectorizer_key: vectorizer.vectorizer_key,
      indexed_chunks: result.chunkCount,
      message: `成功索引文件，生成 ${result.chunkCount} 个分块`,
    };
  }

  deleteIndexedFile(input: DeleteIndexedFileRequest): Record<string, unknown> {
    const collection = input.collection.trim();
    const fileId = input.file_id.trim();
    return this.deleteDocument(collection, fileId);
  }

  migrate(input: GenericVectorRequest): Record<string, unknown> {
    const payload = input ?? {};
    const fromKey = asString(payload.from_key) ?? asString(payload.fromKey);
    const toKey = asString(payload.to_key) ?? asString(payload.toKey);
    if (!fromKey || !toKey) {
      throw new VectorLibraryServiceError("缺少 from_key 或 to_key", 400);
    }
    const source = this.getStoredVectorizer(fromKey);
    const target = this.getStoredVectorizer(toKey);
    if (!source || !target) {
      throw new VectorLibraryServiceError("源或目标向量化器不存在", 404);
    }
    const rows = this.db
      .prepare("SELECT * FROM documents WHERE id IN (SELECT doc_id FROM document_vectors WHERE model_id = ?)")
      .all(source.model_id) as unknown as StoredDocument[];
    let migrated = 0;
    for (const row of rows) {
      this.upsertVector(row.id, row.collection, target.model_id, row.content);
      migrated += 1;
    }
    this.refreshVectorCounts();
    return {
      from_key: fromKey,
      to_key: toKey,
      migrated_chunks: migrated,
    };
  }

  indexDocument(input: GenericVectorRequest): Record<string, unknown> {
    const payload = input ?? {};
    const collection = asString(payload.collection_name) ?? asString(payload.collection) ?? "documents";
    let documentId = asString(payload.document_id) ?? "";
    const chunkSize = readPositiveInteger(payload.chunk_size, 500);
    const overlap = readNonNegativeInteger(payload.overlap, 50);
    let text = asString(payload.text) ?? "";
    const metadata = asRecord(payload.metadata);
    const fileId = asString(payload.file_id);
    if (fileId) {
      const file = this.fileIndex.get(fileId, "global", null);
      if (!file) {
        throw new VectorLibraryServiceError(`文件不存在: ${fileId}`, 404);
      }
      if (!fs.existsSync(file.stored_path)) {
        throw new VectorLibraryServiceError(`文件路径无效: ${file.stored_path}`, 404);
      }
      text = readUtf8File(file.stored_path);
      documentId = documentId || file.id;
      metadata.source = metadata.source ?? file.original_name;
      metadata.source_file = metadata.source_file ?? file.original_name;
      metadata.file_id = file.id;
      metadata.original_filename = file.original_name;
    }
    if (!documentId || !text) {
      throw new VectorLibraryServiceError("document_id和文本内容不能为空", 400);
    }
    const vectorizer = this.resolveActiveVectorizer();
    const result = this.indexTextDocument({
      collection,
      documentId,
      text,
      metadata,
      vectorizer,
      chunkSize,
      overlap,
    });
    return {
      document_id: documentId,
      chunk_count: result.chunkCount,
      collection_name: collection,
      stats: this.collectionInfo(collection),
      message: `成功索引文档，生成 ${result.chunkCount} 个分块`,
    };
  }

  deleteDocument(collectionName: string, documentId: string): Record<string, unknown> {
    const rows = this.db
      .prepare("SELECT id FROM documents WHERE collection = ? AND document_id = ?")
      .all(collectionName, documentId) as Array<{ id: number }>;
    for (const row of rows) {
      this.db.prepare("DELETE FROM document_vectors WHERE doc_id = ?").run(row.id);
    }
    this.db.prepare("DELETE FROM documents WHERE collection = ? AND document_id = ?").run(collectionName, documentId);
    this.refreshVectorCounts();
    return {
      message: `文档 ${documentId} 已从集合 ${collectionName} 中删除`,
      collection: collectionName,
      document_id: documentId,
      deleted_chunks: rows.length,
    };
  }

  deleteCollection(collectionName: string): Record<string, unknown> {
    const rows = this.db
      .prepare("SELECT id FROM documents WHERE collection = ?")
      .all(collectionName) as Array<{ id: number }>;
    for (const row of rows) {
      this.db.prepare("DELETE FROM document_vectors WHERE doc_id = ?").run(row.id);
    }
    this.db.prepare("DELETE FROM documents WHERE collection = ?").run(collectionName);
    this.refreshVectorCounts();
    return {
      message: `集合 ${collectionName} 已删除`,
      collection: collectionName,
      deleted_chunks: rows.length,
    };
  }

  listRerankers(): RerankerConfig[] {
    const shared = this.listSharedRerankers();
    if (shared !== null) {
      return shared;
    }
    const rows = this.db
      .prepare("SELECT * FROM rerankers ORDER BY created_at ASC, reranker_key ASC")
      .all() as unknown as StoredReranker[];
    return rows.map((reranker) => this.toRerankerConfig(reranker));
  }

  addReranker(input: RerankerCreate): { reranker_key: string } {
    const mode = normalizeRerankerMode(input.mode);
    const providerKey = input.provider_key?.trim() || "";
    const modelName = input.model_name?.trim() || "";
    if (mode === "model") {
      if (!providerKey || !modelName) {
        throw new VectorLibraryServiceError("model 模式的重排序器必须提供 provider_key 和 model_name", 400);
      }
      if (!input.api_endpoint?.trim()) {
        throw new VectorLibraryServiceError("model 模式的重排序器必须提供 api_endpoint", 400);
      }
    }

    const key = input.reranker_key?.trim() || normalizeRerankerKey(mode, providerKey, modelName);
    if (this.getStoredReranker(key)) {
      throw new VectorLibraryServiceError(`重排序器键已存在: ${key}`, 400);
    }
    this.db
      .prepare(
        `
          INSERT INTO rerankers
          (reranker_key, mode, provider_key, provider_type, model_name, api_endpoint, api_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        key,
        mode,
        providerKey,
        normalizeNullableString(input.provider_type),
        modelName,
        input.api_endpoint?.trim() || "",
        input.api_key ?? null,
        new Date().toISOString(),
      );
    if (!this.activeRerankerKey) {
      this.activeRerankerKey = key;
      this.writeSetting("active_reranker_key", key);
    }
    return { reranker_key: key };
  }

  getReranker(key: string): RerankerConfig | null {
    const reranker = this.getStoredReranker(key);
    return reranker ? this.toRerankerConfig(reranker) : null;
  }

  activateReranker(key: string): { active_reranker_key: string } {
    if (!this.getStoredReranker(key)) {
      throw new VectorLibraryServiceError(`重排序器不存在: ${key}`, 404);
    }
    this.activeRerankerKey = key;
    this.writeSetting("active_reranker_key", key);
    return { active_reranker_key: key };
  }

  deleteReranker(key: string): { deleted_reranker_key: string } {
    if (!this.getStoredReranker(key)) {
      throw new VectorLibraryServiceError(`重排序器不存在: ${key}`, 404);
    }
    this.db.prepare("DELETE FROM rerankers WHERE reranker_key = ?").run(key);
    if (this.activeRerankerKey === key) {
      const next = this.db.prepare("SELECT reranker_key FROM rerankers ORDER BY created_at ASC LIMIT 1").get() as
        | { reranker_key: string }
        | undefined;
      this.activeRerankerKey = next?.reranker_key ?? null;
      this.writeSetting("active_reranker_key", this.activeRerankerKey);
    }
    return { deleted_reranker_key: key };
  }

  vectorHealth(): Record<string, unknown> {
    return {
      status: "healthy",
      runtime: "local",
      collections_count: this.listCollections().length,
      vectorizers_count: this.listVectorizers().length,
      rerankers_count: this.listRerankers().length,
      active_vectorizer_key: this.activeVectorizerKey,
      active_reranker_key: this.activeRerankerKey,
    };
  }

  listCollections(): Array<Record<string, unknown>> {
    if (this.tableExists("collections")) {
      const rows = this.db
        .prepare(
          `
            SELECT c.name, c.vector_dimension, c.metadata, COUNT(d.id) AS total_chunks
            FROM collections c
            LEFT JOIN documents d ON d.collection = c.name
            GROUP BY c.name, c.vector_dimension, c.metadata
            ORDER BY c.name
          `,
        )
        .all() as Array<{ name: string; vector_dimension: number; metadata: string | null; total_chunks: number }>;
      return rows.map((row) => ({
        name: row.name,
        total_chunks: row.total_chunks,
        embedding_dimension: row.vector_dimension,
        model_name: "",
        metadata: parseMetadata(row.metadata),
      }));
    }
    const rows = this.db
      .prepare(
        `
          SELECT collection AS name, COUNT(*) AS total_chunks, COUNT(DISTINCT document_id) AS document_count
          FROM documents
          GROUP BY collection
          ORDER BY collection
        `,
      )
      .all() as Array<{ name: string; total_chunks: number; document_count: number }>;
    return rows.map((row) => ({
      name: row.name,
      total_chunks: row.total_chunks,
      chunk_count: row.total_chunks,
      document_count: row.document_count,
      embedding_dimension: LOCAL_EMBEDDING_DIMENSION,
      model_name: this.resolveActiveVectorizer().model_name,
      metadata: {
        document_count: row.document_count,
      },
    }));
  }

  listDocuments(collectionName: string): Record<string, unknown> {
    return {
      collection_name: collectionName,
      total_chunks: this.countChunks(collectionName),
      sample_ids: this.sampleDocumentIds(collectionName),
      info: this.collectionInfo(collectionName),
    };
  }

  search(input: SearchVectorsRequest): Record<string, unknown> {
    const collectionName = input.collection_name?.trim() || input.collection?.trim() || "documents";
    const query = input.query.trim();
    const topK = input.top_k ?? 5;
    const searchMode = input.search_mode ?? input.mode ?? "hybrid";
    if (!query) {
      throw new VectorLibraryServiceError("查询内容不能为空", 400);
    }
    if (searchMode !== "hybrid" && searchMode !== "vector") {
      throw new VectorLibraryServiceError("search_mode 只能是 hybrid 或 vector", 400);
    }
    const vectorizer = this.resolveActiveVectorizer();
    const rows = this.loadSearchRows(collectionName, vectorizer.model_id);
    const queryVector = embedText(query);
    let results = rows
      .map((row) => scoreRow(row, query, queryVector))
      .filter((row) => row.keyword_score > 0 || row.vector_score > 0)
      .sort((left, right) => (searchMode === "vector" ? right.vector_score - left.vector_score : right.hybrid_score - left.hybrid_score))
      .slice(0, input.rerank_top_k ?? Math.max(topK, 20))
      .map(toSearchResult);
    const rerank = input.rerank === true && searchMode === "hybrid";
    if (rerank) {
      results = lexicalRerank(results, query);
    }
    const finalTopK = input.final_top_k ?? topK;
    results = results.slice(0, finalTopK);
    return {
      results,
      count: results.length,
      collection_name: collectionName,
      query,
      search_mode: searchMode,
      rerank,
      rerank_mode: rerank ? input.rerank_mode ?? "local" : "none",
    };
  }

  getModelStats(modelId: number): {
    vector_count: number;
    storage_size_mb: number;
    collections: Record<string, number>;
  } {
    const rows = this.db
      .prepare(
        `
          SELECT collection, COUNT(*) AS count
          FROM document_vectors
          WHERE model_id = ?
          GROUP BY collection
        `,
      )
      .all(modelId) as Array<{ collection: string; count: number }>;
    const collections = Object.fromEntries(rows.map((row) => [row.collection, row.count]));
    const vectorCount = rows.reduce((sum, row) => sum + row.count, 0);
    const dimension = this.getEmbeddingModelById(modelId)?.vector_dimension ?? LOCAL_EMBEDDING_DIMENSION;
    return {
      vector_count: vectorCount,
      storage_size_mb: Math.round((vectorCount * dimension * 4 / 1024 / 1024) * 100) / 100,
      collections,
    };
  }

  getSyncStatus(collection: string): Array<{
    model_id: number;
    vectorizer_key: string;
    total_documents: number;
    synced_documents: number;
    pending_documents: number;
    sync_percentage: number;
  }> {
    return this.listVectorizers()
      .filter((vectorizer) => vectorizer.model_id !== null)
      .map((vectorizer) => {
        const modelId = vectorizer.model_id!;
        const totalDocuments = this.countChunks(collection);
        const syncedDocuments = this.db
          .prepare("SELECT COUNT(*) AS count FROM document_vectors WHERE collection = ? AND model_id = ?")
          .get(collection, modelId) as { count: number } | undefined;
        const synced = syncedDocuments?.count ?? 0;
        return {
          model_id: modelId,
          vectorizer_key: vectorizer.vectorizer_key,
          total_documents: totalDocuments,
          synced_documents: synced,
          pending_documents: Math.max(totalDocuments - synced, 0),
          sync_percentage: totalDocuments ? Math.round((synced / totalDocuments) * 10000) / 100 : 0,
        };
      });
  }

  syncModel(modelId: number, input: { collection: string; limit?: number | null | undefined }): Record<string, unknown> {
    const vectorizer = this.getVectorizerByModelId(modelId);
    if (!vectorizer) {
      throw new VectorLibraryServiceError(`模型不存在: ${modelId}`, 404);
    }
    const collection = input.collection || "default";
    const rows = this.db
      .prepare(
        `
          SELECT d.* FROM documents d
          LEFT JOIN document_vectors v ON v.doc_id = d.id AND v.model_id = ?
          WHERE d.collection = ? AND v.id IS NULL
          ORDER BY d.id ASC
          ${input.limit ? "LIMIT ?" : ""}
        `,
      )
      .all(...(input.limit ? [modelId, collection, input.limit] : [modelId, collection])) as unknown as StoredDocument[];
    for (const row of rows) {
      this.upsertVector(row.id, row.collection, vectorizer.model_id, row.content);
    }
    this.refreshVectorCounts();
    return {
      model_id: modelId,
      collection,
      synced_documents: rows.length,
    };
  }

  private indexTextDocument(input: {
    collection: string;
    documentId: string;
    text: string;
    metadata: Record<string, unknown>;
    vectorizer: StoredVectorizer;
    chunkSize: number;
    overlap: number;
  }): { chunkCount: number } {
    const chunks = chunkText(input.text, input.chunkSize, input.overlap);
    this.deleteDocument(input.collection, input.documentId);
    const now = new Date().toISOString();
    const insertDocument = this.db.prepare(
      `
        INSERT INTO documents
        (collection, document_id, chunk_index, content, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    );
    for (const [index, chunk] of chunks.entries()) {
      const metadata = {
        ...input.metadata,
        document_id: input.documentId,
        chunk_index: index,
      };
      const result = insertDocument.run(
        input.collection,
        input.documentId,
        index,
        chunk,
        JSON.stringify(metadata),
        now,
      );
      this.upsertVector(Number(result.lastInsertRowid), input.collection, input.vectorizer.model_id, chunk);
    }
    this.refreshVectorCounts();
    return { chunkCount: chunks.length };
  }

  private upsertVector(docId: number, collection: string, modelId: number, text: string): void {
    const vector = embedText(text);
    this.db.prepare("DELETE FROM document_vectors WHERE doc_id = ? AND collection = ? AND model_id = ?").run(docId, collection, modelId);
    this.db
      .prepare("INSERT INTO document_vectors (doc_id, collection, model_id, embedding) VALUES (?, ?, ?, ?)")
      .run(docId, collection, modelId, JSON.stringify(vector));
  }

  private resolveActiveVectorizer(): StoredVectorizer {
    if (this.activeVectorizerKey) {
      const active = this.getStoredVectorizer(this.activeVectorizerKey);
      if (active) {
        return active;
      }
    }
    const existing = this.db.prepare("SELECT * FROM vectorizers ORDER BY model_id ASC LIMIT 1").get() as StoredVectorizer | undefined;
    if (existing) {
      this.activeVectorizerKey = existing.vectorizer_key;
      this.writeSetting("active_vectorizer_key", existing.vectorizer_key);
      return existing;
    }
    const localKey = "local_hash_embedding";
    this.db
      .prepare(
        `
          INSERT INTO vectorizers
          (vectorizer_key, provider_key, provider_type, model_name, distance_metric, created_at, vector_dimension, vector_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(localKey, "local", "local", "hash-embedding", "cosine", new Date().toISOString(), LOCAL_EMBEDDING_DIMENSION, 0);
    this.activeVectorizerKey = localKey;
    this.writeSetting("active_vectorizer_key", localKey);
    return this.getStoredVectorizer(localKey)!;
  }

  private loadSearchRows(collection: string, modelId: number): ScoredRowInput[] {
    return this.db
      .prepare(
        `
          SELECT d.id, d.document_id, d.collection, d.content, d.metadata, v.embedding
          FROM documents d
          LEFT JOIN document_vectors v ON v.doc_id = d.id AND v.model_id = ?
          WHERE d.collection = ?
          ORDER BY d.id ASC
        `,
      )
      .all(modelId, collection)
      .map((row) => normalizeSearchRow(row as Record<string, unknown>));
  }

  private collectionInfo(collectionName: string): Record<string, unknown> {
    return {
      name: collectionName,
      total_chunks: this.countChunks(collectionName),
      document_count: this.countDocuments(collectionName),
      sample_ids: this.sampleDocumentIds(collectionName),
      vector_dimension: LOCAL_EMBEDDING_DIMENSION,
      active_vectorizer_key: this.activeVectorizerKey,
    };
  }

  private listFileStatusVectorizers(): FileStatusVectorizer[] {
    return this.listVectorizers().map((vectorizer) => ({
      vectorizer_key: vectorizer.vectorizer_key,
      model_name: vectorizer.model_name,
      provider_key: vectorizer.provider_key,
      dimension: vectorizer.vector_dimension ?? 0,
      model_id: vectorizer.model_id,
    }));
  }

  private listSharedVectorizers(): VectorizerConfig[] | null {
    const config = this.readVectorizerConfig();
    if (!config) {
      return null;
    }
    return config.vectorizers.map((vectorizer) => {
      const model = this.getEmbeddingModelByVectorizerKey(vectorizer.vectorizer_key);
      const stats = model ? this.getModelStats(model.id) : { vector_count: 0 };
      return {
        vectorizer_key: vectorizer.vectorizer_key,
        provider_key: vectorizer.provider_key,
        provider_type: vectorizer.provider_type,
        model_name: vectorizer.model_name,
        distance_metric: vectorizer.distance_metric,
        created_at: vectorizer.created_at,
        is_active: vectorizer.vectorizer_key === config.active_vectorizer_key,
        provider_available: vectorizer.provider_key ? this.modelAdapter.hasProvider(vectorizer.provider_key) : false,
        vector_dimension: model?.vector_dimension ?? null,
        vector_count: stats.vector_count,
        model_id: model?.id ?? null,
      };
    });
  }

  private listSharedRerankers(): RerankerConfig[] | null {
    const config = this.readRerankerConfig();
    if (!config) {
      return null;
    }
    return config.rerankers.map((reranker) => ({
      reranker_key: reranker.reranker_key,
      mode: reranker.mode,
      provider_key: reranker.provider_key,
      provider_type: reranker.provider_type,
      model_name: reranker.model_name,
      api_endpoint: reranker.api_endpoint,
      created_at: reranker.created_at,
      is_active: reranker.reranker_key === config.active_reranker_key,
    }));
  }

  private readVectorizerConfig(): SharedVectorizerYaml | null {
    const raw = this.readYamlRecord(this.vectorizersConfigPath);
    if (!raw || !isRecord(raw.vectorizers)) {
      return null;
    }
    const active = typeof raw.active_vectorizer_key === "string" && raw.active_vectorizer_key.trim()
      ? raw.active_vectorizer_key
      : null;
    const vectorizers = Object.entries(raw.vectorizers).flatMap(([key, value]) => {
      if (!isRecord(value)) {
        return [];
      }
      return [{
        vectorizer_key: key,
        provider_key: asPlainString(value.provider_key),
        provider_type: asNullablePlainString(value.provider_type),
        model_name: asPlainString(value.model_name),
        distance_metric: asPlainString(value.distance_metric) || "cosine",
        created_at: asPlainString(value.created_at),
      }];
    });
    return { active_vectorizer_key: active, vectorizers };
  }

  private readRerankerConfig(): SharedRerankerYaml | null {
    const raw = this.readYamlRecord(this.rerankersConfigPath);
    if (!raw || !isRecord(raw.rerankers)) {
      return null;
    }
    const active = typeof raw.active_reranker_key === "string" && raw.active_reranker_key.trim()
      ? raw.active_reranker_key
      : null;
    const rerankers = Object.entries(raw.rerankers).flatMap(([key, value]) => {
      if (!isRecord(value)) {
        return [];
      }
      return [{
        reranker_key: key,
        mode: normalizeRerankerModeValue(value.mode),
        provider_key: asPlainString(value.provider_key),
        provider_type: asNullablePlainString(value.provider_type),
        model_name: asPlainString(value.model_name),
        api_endpoint: asPlainString(value.api_endpoint),
        created_at: asPlainString(value.created_at),
      }];
    });
    return { active_reranker_key: active, rerankers };
  }

  private readYamlRecord(filePath: string): Record<string, unknown> | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const parsed = YAML.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private listSharedDocumentFileStatuses(vectorizers: FileStatusVectorizer[]): VectorFileStatus[] | null {
    if (!this.tableExists("documents") || !this.tableExists("document_vectors")) {
      return null;
    }
    const rows = this.db
      .prepare(
        `
          SELECT
            collection,
            json_extract(metadata, '$.document_id') AS file_id,
            MAX(COALESCE(
              NULLIF(TRIM(REPLACE(json_extract(metadata, '$.original_filename'), '"', '')), ''),
              NULLIF(TRIM(REPLACE(json_extract(metadata, '$.source'), '"', '')), ''),
              json_extract(metadata, '$.document_id')
            )) AS file_name,
            COUNT(*) AS chunk_count
          FROM documents
          WHERE json_extract(metadata, '$.document_id') IS NOT NULL
            AND json_extract(metadata, '$.document_id') != ''
          GROUP BY collection, file_id
          ORDER BY collection, file_name
        `,
      )
      .all() as Array<{
        collection: string;
        file_id: string | null;
        file_name: string | null;
        chunk_count: number;
      }>;

    return rows.map((row) => {
      const collection = String(row.collection ?? "");
      const fileId = cleanJsonExtractedString(row.file_id);
      const chunkCount = Number(row.chunk_count ?? 0);
      const status = Object.fromEntries(
        vectorizers.map((vectorizer) => [
          vectorizer.vectorizer_key,
          this.countVectorsForMetadataDocument(collection, fileId, vectorizer.model_id) === chunkCount && chunkCount > 0
            ? "已索引"
            : "未索引",
        ]),
      ) as Record<string, "已索引" | "未索引">;
      return {
        file_name: cleanJsonExtractedString(row.file_name) || fileId,
        file_id: fileId,
        collection,
        chunk_count: chunkCount,
        vectorizer_status: status,
      };
    });
  }

  private toVectorizerConfig(vectorizer: StoredVectorizer): VectorizerConfig {
    const stats = this.getModelStats(vectorizer.model_id);
    return {
      vectorizer_key: vectorizer.vectorizer_key,
      provider_key: vectorizer.provider_key,
      provider_type: vectorizer.provider_type,
      model_name: vectorizer.model_name,
      distance_metric: vectorizer.distance_metric,
      created_at: vectorizer.created_at,
      is_active: vectorizer.vectorizer_key === this.activeVectorizerKey,
      provider_available: vectorizer.provider_key === "local" || this.modelAdapter.hasProvider(vectorizer.provider_key),
      vector_dimension: vectorizer.vector_dimension,
      vector_count: stats.vector_count,
      model_id: vectorizer.model_id,
    };
  }

  private toRerankerConfig(reranker: StoredReranker): RerankerConfig {
    const config: RerankerConfig = {
      reranker_key: reranker.reranker_key,
      mode: reranker.mode,
      provider_key: reranker.provider_key,
      provider_type: reranker.provider_type,
      model_name: reranker.model_name,
      api_endpoint: reranker.api_endpoint,
      created_at: reranker.created_at,
      is_active: reranker.reranker_key === this.activeRerankerKey,
    };
    if (reranker.api_key !== null) {
      config.api_key = reranker.api_key;
    }
    return config;
  }

  private getStoredVectorizer(key: string): StoredVectorizer | null {
    const row = this.db.prepare("SELECT * FROM vectorizers WHERE vectorizer_key = ?").get(key) as StoredVectorizer | undefined;
    return row ?? null;
  }

  private getVectorizerByModelId(modelId: number): StoredVectorizer | null {
    const row = this.db.prepare("SELECT * FROM vectorizers WHERE model_id = ?").get(modelId) as StoredVectorizer | undefined;
    return row ?? null;
  }

  private getStoredReranker(key: string): StoredReranker | null {
    const row = this.db.prepare("SELECT * FROM rerankers WHERE reranker_key = ?").get(key) as StoredReranker | undefined;
    return row ?? null;
  }

  private getEmbeddingModelByVectorizerKey(vectorizerKey: string): StoredEmbeddingModel | null {
    if (!this.tableExists("embedding_models")) {
      return null;
    }
    const row = this.db
      .prepare("SELECT * FROM embedding_models WHERE vectorizer_key = ? LIMIT 1")
      .get(vectorizerKey) as StoredEmbeddingModel | undefined;
    return row ?? null;
  }

  private getEmbeddingModelById(modelId: number): StoredEmbeddingModel | null {
    if (!this.tableExists("embedding_models")) {
      return null;
    }
    const row = this.db.prepare("SELECT * FROM embedding_models WHERE id = ?").get(modelId) as StoredEmbeddingModel | undefined;
    return row ?? null;
  }

  private countChunks(collectionName: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM documents WHERE collection = ?").get(collectionName) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  private countDocuments(collectionName: string): number {
    const row = this.db.prepare("SELECT COUNT(DISTINCT document_id) AS count FROM documents WHERE collection = ?").get(collectionName) as
      | { count: number }
      | undefined;
    return row?.count ?? 0;
  }

  private sampleDocumentIds(collectionName: string): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT document_id FROM documents WHERE collection = ? ORDER BY document_id LIMIT 20")
      .all(collectionName) as Array<{ document_id: string }>;
    return rows.map((row) => row.document_id);
  }

  private countChunksForDocument(collection: string, documentId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM documents WHERE collection = ? AND document_id = ?")
      .get(collection, documentId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private countVectorsForDocument(collection: string, documentId: string, modelId: number | null): number {
    if (modelId === null) {
      return 0;
    }
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM document_vectors v
          JOIN documents d ON d.id = v.doc_id
          WHERE d.collection = ? AND d.document_id = ? AND v.model_id = ?
        `,
      )
      .get(collection, documentId, modelId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private countVectorsForMetadataDocument(collection: string, fileId: string, modelId: number | null): number {
    if (modelId === null || !fileId) {
      return 0;
    }
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM document_vectors
          WHERE model_id = ?
            AND collection = ?
            AND doc_id IN (
              SELECT id
              FROM documents
              WHERE collection = ?
                AND json_extract(metadata, '$.document_id') = ?
            )
        `,
      )
      .get(modelId, collection, collection, fileId) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private defaultCollectionForFile(fileId: string): string {
    const row = this.db
      .prepare("SELECT collection FROM documents WHERE document_id = ? ORDER BY id ASC LIMIT 1")
      .get(fileId) as { collection: string } | undefined;
    return row?.collection ?? "documents";
  }

  private refreshVectorCounts(): void {
    const rows = this.db
      .prepare("SELECT model_id, COUNT(*) AS count FROM document_vectors GROUP BY model_id")
      .all() as Array<{ model_id: number; count: number }>;
    this.db.prepare("UPDATE vectorizers SET vector_count = 0").run();
    for (const row of rows) {
      this.db.prepare("UPDATE vectorizers SET vector_count = ? WHERE model_id = ?").run(row.count, row.model_id);
    }
  }

  private readSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM vector_settings WHERE key = ?").get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  private writeSetting(key: string, value: string | null): void {
    this.db
      .prepare("INSERT OR REPLACE INTO vector_settings (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vector_settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS vectorizers (
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

      CREATE TABLE IF NOT EXISTS rerankers (
        reranker_key TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        provider_type TEXT,
        model_name TEXT NOT NULL,
        api_endpoint TEXT NOT NULL,
        api_key TEXT,
        created_at TEXT NOT NULL
      );
    `);

    this.ensureDocumentTables();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        document_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_collection_doc_chunk
        ON documents(collection, document_id, chunk_index);
      CREATE INDEX IF NOT EXISTS idx_documents_collection_doc
        ON documents(collection, document_id);

      CREATE TABLE IF NOT EXISTS document_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL,
        collection TEXT NOT NULL,
        model_id INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        UNIQUE(doc_id, collection, model_id)
      );

      CREATE INDEX IF NOT EXISTS idx_document_vectors_model_collection
        ON document_vectors(model_id, collection);
    `);
  }

  private ensureDocumentTables(): void {
    if (!this.tableExists("documents")) {
      return;
    }
    const columns = this.tableColumns("documents");
    const idColumn = columns.find((column) => column.name === "id");
    const hasCurrentShape =
      Boolean(idColumn?.type.toUpperCase().includes("INTEGER")) &&
      columns.some((column) => column.name === "document_id") &&
      columns.some((column) => column.name === "chunk_index");
    if (!hasCurrentShape) {
      this.migrateLegacyDocumentTables();
    }
  }

  private migrateLegacyDocumentTables(): void {
    const suffix = Date.now().toString(36);
    const legacyDocuments = `documents_legacy_${suffix}`;
    const legacyVectors = `document_vectors_legacy_${suffix}`;
    const hadVectors = this.tableExists("document_vectors");
    this.db.exec("BEGIN");
    try {
      this.db.exec(`ALTER TABLE documents RENAME TO ${quoteIdentifier(legacyDocuments)}`);
      if (hadVectors) {
        this.db.exec(`ALTER TABLE document_vectors RENAME TO ${quoteIdentifier(legacyVectors)}`);
      }
      this.createCurrentDocumentTables();
      const mapping = this.copyLegacyDocuments(legacyDocuments);
      if (hadVectors) {
        this.copyLegacyVectors(legacyVectors, mapping);
      }
      this.db.exec(`DROP TABLE ${quoteIdentifier(legacyDocuments)}`);
      if (hadVectors) {
        this.db.exec(`DROP TABLE ${quoteIdentifier(legacyVectors)}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createCurrentDocumentTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        document_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS document_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL,
        collection TEXT NOT NULL,
        model_id INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        UNIQUE(doc_id, collection, model_id)
      );
    `);
  }

  private copyLegacyDocuments(legacyTable: string): Map<string, { id: number; content: string }> {
    const mapping = new Map<string, { id: number; content: string }>();
    const rows = this.db
      .prepare(
        `
          SELECT id, collection, content, metadata, created_at
          FROM ${quoteIdentifier(legacyTable)}
          ORDER BY collection, id
        `,
      )
      .all() as Array<{
        id: unknown;
        collection: unknown;
        content: unknown;
        metadata: unknown;
        created_at: unknown;
      }>;
    const insert = this.db.prepare(
      `
        INSERT INTO documents
        (collection, document_id, chunk_index, content, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    );
    for (const row of rows) {
      const collection = String(row.collection ?? "documents");
      const documentId = String(row.id ?? "");
      if (!documentId) {
        continue;
      }
      const content = String(row.content ?? "");
      const metadata = normalizeLegacyMetadata(row.metadata, documentId);
      const createdAt = typeof row.created_at === "string" && row.created_at.trim()
        ? row.created_at
        : new Date().toISOString();
      const result = insert.run(collection, documentId, 0, content, metadata, createdAt);
      mapping.set(legacyDocumentKey(collection, documentId), {
        id: Number(result.lastInsertRowid),
        content,
      });
    }
    return mapping;
  }

  private copyLegacyVectors(legacyTable: string, mapping: Map<string, { id: number; content: string }>): void {
    const rows = this.db
      .prepare(
        `
          SELECT doc_id, collection, model_id, embedding
          FROM ${quoteIdentifier(legacyTable)}
          ORDER BY id
        `,
      )
      .all() as Array<{
        doc_id: unknown;
        collection: unknown;
        model_id: unknown;
        embedding: unknown;
      }>;
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO document_vectors (doc_id, collection, model_id, embedding) VALUES (?, ?, ?, ?)",
    );
    for (const row of rows) {
      const collection = String(row.collection ?? "documents");
      const legacyDocId = String(row.doc_id ?? "");
      const modelId = Number(row.model_id);
      const mapped = mapping.get(legacyDocumentKey(collection, legacyDocId));
      if (!mapped || !Number.isInteger(modelId)) {
        continue;
      }
      insert.run(mapped.id, collection, modelId, normalizeLegacyEmbedding(row.embedding, mapped.content));
    }
  }

  private tableExists(tableName: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { name: string } | undefined;
    return Boolean(row);
  }

  private tableColumns(tableName: string): Array<{ name: string; type: string }> {
    return this.db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string; type: string }>;
  }
}

interface StoredVectorizer {
  model_id: number;
  vectorizer_key: string;
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  distance_metric: string;
  created_at: string;
  vector_dimension: number | null;
  vector_count: number;
}

interface StoredReranker {
  reranker_key: string;
  mode: "model" | "lexical" | "none";
  provider_key: string;
  provider_type: string | null;
  model_name: string;
  api_endpoint: string;
  created_at: string;
  api_key: string | null;
}

interface StoredEmbeddingModel {
  id: number;
  model_key: string;
  provider: string;
  model_name: string;
  vector_dimension: number;
  distance_metric: string;
  is_active: number | boolean;
  api_endpoint: string | null;
  created_at: string;
  last_used_at: string;
  vectorizer_key: string | null;
}

interface SharedVectorizerYaml {
  active_vectorizer_key: string | null;
  vectorizers: Array<{
    vectorizer_key: string;
    provider_key: string;
    provider_type: string | null;
    model_name: string;
    distance_metric: string;
    created_at: string;
  }>;
}

interface SharedRerankerYaml {
  active_reranker_key: string | null;
  rerankers: Array<{
    reranker_key: string;
    mode: "model" | "lexical" | "none";
    provider_key: string;
    provider_type: string | null;
    model_name: string;
    api_endpoint: string;
    created_at: string;
  }>;
}

interface StoredDocument {
  id: number;
  collection: string;
  document_id: string;
  chunk_index: number;
  content: string;
  metadata: string;
  created_at: string;
}

interface ScoredRowInput {
  id: number;
  documentId: string;
  collection: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding: number[];
}

interface ScoredRow extends ScoredRowInput {
  keyword_score: number;
  vector_score: number;
  hybrid_score: number;
}

const LOCAL_EMBEDDING_DIMENSION = 64;

function normalizeVectorizerKey(providerKey: string, modelName: string): string {
  return `${providerKey}_${safeKeyPart(modelName)}`;
}

function normalizeRerankerKey(mode: "model" | "lexical" | "none", providerKey: string, modelName: string): string {
  if (mode === "none") {
    return "noop";
  }
  if (mode === "lexical") {
    return "bm25_local";
  }
  return `${providerKey}_${safeKeyPart(modelName)}`;
}

function safeKeyPart(value: string): string {
  return value.replace(/[^\w.-]/g, "_").slice(0, 120);
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeRerankerMode(value: string | undefined): "model" | "lexical" | "none" {
  const mode = String(value ?? "none")
    .trim()
    .toLowerCase();
  if (["lexical", "bm25", "keyword", "local"].includes(mode)) {
    return "lexical";
  }
  if (["none", "noop"].includes(mode)) {
    return "none";
  }
  return "model";
}

function normalizeRerankerModeValue(value: unknown): "model" | "lexical" | "none" {
  return normalizeRerankerMode(typeof value === "string" ? value : undefined);
}

function cleanJsonExtractedString(value: unknown): string {
  return String(value ?? "").trim().replace(/^"+|"+$/g, "");
}

function readUtf8File(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new VectorLibraryServiceError(`读取文件失败: ${error instanceof Error ? error.message : String(error)}`, 500);
  }
}

function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const safeChunkSize = Math.max(1, chunkSize);
  const safeOverlap = Math.min(Math.max(0, overlap), Math.max(0, safeChunkSize - 1));
  const chunks: string[] = [];
  let index = 0;
  while (index < normalized.length) {
    const end = Math.min(index + safeChunkSize, normalized.length);
    chunks.push(normalized.slice(index, end));
    if (end === normalized.length) {
      break;
    }
    index = end - safeOverlap;
  }
  return chunks;
}

function embedText(text: string): number[] {
  const vector = Array.from({ length: LOCAL_EMBEDDING_DIMENSION }, () => 0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const index = positiveHash(token) % LOCAL_EMBEDDING_DIMENSION;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function scoreRow(row: ScoredRowInput, query: string, queryVector: number[]): ScoredRow {
  const vectorScore = cosineSimilarity(queryVector, row.embedding);
  const keywordScore = keywordOverlapScore(query, row.content);
  const hybridScore = vectorScore * 0.7 + keywordScore * 0.3;
  return {
    ...row,
    keyword_score: keywordScore,
    vector_score: vectorScore,
    hybrid_score: hybridScore,
  };
}

function toSearchResult(row: ScoredRow): VectorSearchResult {
  const score = Math.round(row.hybrid_score * 10000) / 10000;
  return {
    id: String(row.id),
    doc_id: String(row.id),
    document_id: row.documentId,
    collection: row.collection,
    text: row.content,
    content: row.content,
    metadata: row.metadata,
    score,
    similarity: Math.round(row.vector_score * 10000) / 10000,
    keyword_score: Math.round(row.keyword_score * 10000) / 10000,
    vector_score: Math.round(row.vector_score * 10000) / 10000,
    hybrid_score: score,
  };
}

function lexicalRerank(results: VectorSearchResult[], query: string): VectorSearchResult[] {
  return results
    .map((result) => ({
      ...result,
      rerank_score: Math.round(keywordOverlapScore(query, result.content) * 10000) / 10000,
    }))
    .sort((left, right) => (right.rerank_score ?? 0) - (left.rerank_score ?? 0) || right.hybrid_score - left.hybrid_score);
}

function normalizeSearchRow(row: Record<string, unknown>): ScoredRowInput {
  return {
    id: Number(row.id),
    documentId: String(row.document_id ?? ""),
    collection: String(row.collection ?? ""),
    content: String(row.content ?? ""),
    metadata: parseMetadata(row.metadata),
    embedding: parseEmbedding(row.embedding) ?? embedText(String(row.content ?? "")),
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function parseEmbedding(value: unknown): number[] | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(Number).filter((item) => Number.isFinite(item)) : null;
  } catch {
    return null;
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function keywordOverlapScore(query: string, content: string): number {
  const queryTokens = new Set(tokenize(query));
  if (!queryTokens.size) {
    return 0;
  }
  const contentTokens = new Set(tokenize(content));
  let overlap = 0;
  for (const token of queryTokens) {
    if (contentTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / queryTokens.size;
}

function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return words.flatMap((word) => {
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 1) {
      const grams: string[] = [word];
      for (let index = 0; index < word.length - 1; index += 1) {
        grams.push(word.slice(index, index + 2));
      }
      return grams;
    }
    return [word];
  });
}

function positiveHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asPlainString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullablePlainString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function legacyDocumentKey(collection: string, documentId: string): string {
  return `${collection}\u0000${documentId}`;
}

function normalizeLegacyMetadata(value: unknown, documentId: string): string {
  const parsed = parseMetadata(value);
  return JSON.stringify({
    ...parsed,
    document_id: typeof parsed.document_id === "string" ? parsed.document_id : documentId,
    chunk_index: typeof parsed.chunk_index === "number" ? parsed.chunk_index : 0,
  });
}

function normalizeLegacyEmbedding(value: unknown, fallbackText: string): string {
  if (typeof value === "string") {
    const parsed = parseEmbedding(value);
    if (parsed) {
      return JSON.stringify(parsed);
    }
  }
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString("utf8");
    const parsed = parseEmbedding(text);
    if (parsed) {
      return JSON.stringify(parsed);
    }
  }
  return JSON.stringify(embedText(fallbackText));
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
