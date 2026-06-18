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
  VectorSearchResult,
} from "../../contracts/vector-library.js";
import type { IFileIndexStore } from "../../contracts/file-index-store/index.js";
import type { IEmbedder, IVectorStore, VectorRecord, VectorSearchHit } from "../../contracts/vector-store/index.js";
import type { ModelAdapterService } from "../integrations/model-adapter-service.js";
import { createEmbedder, HashFallbackEmbedder } from "../integrations/embedder-registry.js";
// 打分纯函数统一从 scoring.ts 复用(cosineSimilarity/tokenize 随 5h-2 降级路径删除,本地副本已无)。
import { hybridScore, keywordOverlapScore } from "../vector-store/scoring.js";
import { VectorLibraryServiceError } from "../../contracts/vector-library.js";

// 契约泄漏修复:VectorLibraryServiceError / VectorSearchResult 收编至 contracts/vector-library.ts。
// 本文件 re-export 保持 KnowledgeTools/routes 的 `from service` import 暂时兼容(Batch 5 改向 contracts)。
export { VectorLibraryServiceError } from "../../contracts/vector-library.js";
export type { VectorSearchResult } from "../../contracts/vector-library.js";

export class VectorLibraryService {
  private readonly db: import("node:sqlite").DatabaseSync;
  private readonly dataRoot: string;
  private readonly vectorizersConfigPath: string;
  private readonly rerankersConfigPath: string;
  private activeVectorizerKey: string | null = null;
  private activeRerankerKey: string | null = null;
  private readonly vectorStore: IVectorStore | undefined;
  // 按 vectorizer_key 缓存 embedder,避免每次 search 重复解析 provider 配置。
  // 注:provider 配置(api_key 等)运行时更新后,缓存项持有旧快照——本期接受(重启生效),后续可加失效。
  private readonly embedderCache = new Map<string, IEmbedder>();

  constructor(
    private readonly fileIndex: IFileIndexStore,
    private readonly modelAdapter: ModelAdapterService,
    options: {
      dbPath?: string | undefined;
      dataRoot?: string | undefined;
      vectorStore?: IVectorStore | undefined;
    } = {},
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
    this.vectorStore = options.vectorStore;
    this.initDatabase();
    this.activeVectorizerKey = this.readSetting("active_vectorizer_key");
    this.activeRerankerKey = this.readSetting("active_reranker_key");
  }

  close(): void {
    this.db.close();
    this.vectorStore?.close();
  }

  async fileStatus(): Promise<VectorFileStatusResponse> {
    const vectorizers = await this.listFileStatusVectorizers();
    const files = await this.listSharedDocumentFileStatuses(vectorizers);
    if (files !== null) {
      return { files, vectorizers };
    }
    const fileStatuses: VectorFileStatus[] = [];
    for (const file of this.fileIndex.list({ scopeType: "global", scopeId: null })) {
      const collection = this.defaultCollectionForFile(file.id);
      const chunkCount = this.countChunksForDocument(collection, file.id);
      const status: Record<string, "已索引" | "未索引"> = {};
      for (const vectorizer of vectorizers) {
        const vectorCount = await this.countVectorsForDocument(collection, file.id, vectorizer.model_id);
        status[vectorizer.vectorizer_key] = vectorCount >= chunkCount && chunkCount > 0 ? "已索引" : "未索引";
      }
      fileStatuses.push({
        file_name: file.original_name,
        file_id: file.id,
        collection,
        chunk_count: chunkCount,
        vectorizer_status: status,
        uploaded_at: file.uploaded_at,
        size: file.size,
        mime: file.mime,
      });
    }
    return { files: fileStatuses, vectorizers };
  }

  async listVectorizers(): Promise<VectorizerConfig[]> {
    const shared = await this.listSharedVectorizers();
    if (shared !== null) {
      return shared;
    }
    const rows = this.db
      .prepare("SELECT * FROM vectorizers ORDER BY model_id ASC")
      .all() as unknown as StoredVectorizer[];
    const configs: VectorizerConfig[] = [];
    for (const vectorizer of rows) {
      configs.push(await this.toVectorizerConfig(vectorizer));
    }
    return configs;
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
    // 占位维度 null:真维度未知直到 index(由 driver.getDimension 在 listVectorizers/toVectorizerConfig 暴露)。
    const dimension: number | null = null;
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

  async deleteVectorizer(key: string): Promise<{ deleted_vectorizer_key: string }> {
    const vectorizer = this.getStoredVectorizer(key);
    if (!vectorizer) {
      throw new VectorLibraryServiceError(`向量化器不存在: ${key}`, 404);
    }
    // B/A 解耦:经 driver.deleteByModel 删向量数据(而非直连库),切断 vectorizer 元数据与向量数据物理耦合
    if (this.vectorStore) {
      await this.vectorStore.deleteByModel(vectorizer.model_id);
    }
    this.db.prepare("DELETE FROM vectorizers WHERE vectorizer_key = ?").run(key);
    if (this.activeVectorizerKey === key) {
      const next = this.db.prepare("SELECT vectorizer_key FROM vectorizers ORDER BY model_id ASC LIMIT 1").get() as
        | { vectorizer_key: string }
        | undefined;
      this.activeVectorizerKey = next?.vectorizer_key ?? null;
      this.writeSetting("active_vectorizer_key", this.activeVectorizerKey);
    }
    return { deleted_vectorizer_key: key };
  }

  async listDocsByVectorizer(key: string): Promise<Array<Record<string, unknown>>> {
    const vectorizer = this.getStoredVectorizer(key);
    if (!vectorizer) {
      throw new VectorLibraryServiceError(`向量化器不存在或未在 DB 注册: ${key}`, 404);
    }
    if (!this.vectorStore) {
      return [];
    }
    // driver 唯一向量源:service.documents 列文档(chunk 索引,全 model 共用),
    // driver.countVectorsForDocument 按 model_id 过滤该 vectorizer 实际索引的文档 + 计向量数(N+1,管理操作低频可接受)。
    const docs = this.db
      .prepare(
        `
          SELECT document_id, collection, MIN(metadata) AS metadata
          FROM documents
          GROUP BY collection, document_id
          ORDER BY collection, document_id
        `,
      )
      .all() as Array<{ document_id: string; collection: string; metadata: string }>;
    const result: Array<Record<string, unknown>> = [];
    for (const doc of docs) {
      const vectorCount = await this.vectorStore.countVectorsForDocument(doc.collection, doc.document_id, vectorizer.model_id);
      if (vectorCount > 0) {
        result.push({
          document_id: doc.document_id,
          collection: doc.collection,
          vector_count: vectorCount,
          metadata: doc.metadata,
        });
      }
    }
    return result;
  }

  async indexFile(input: IndexFileRequest): Promise<Record<string, unknown>> {
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
    const result = await this.indexTextDocument({
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

  async deleteIndexedFile(input: DeleteIndexedFileRequest): Promise<Record<string, unknown>> {
    const collection = input.collection.trim();
    const fileId = input.file_id.trim();
    return this.deleteDocument(collection, fileId);
  }

  async migrate(input: GenericVectorRequest): Promise<Record<string, unknown>> {
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
    if (!this.vectorStore) {
      return { from_key: fromKey, to_key: toKey, migrated_chunks: 0 };
    }
    // driver 唯一源:找 source model 已索引的文档(countVectorsForDocument>0),取其全部 chunk 用 target 重嵌。
    const distinctDocs = this.db
      .prepare("SELECT DISTINCT collection, document_id FROM documents ORDER BY collection, document_id")
      .all() as Array<{ collection: string; document_id: string }>;
    const sourceKeys = new Set<string>();
    for (const doc of distinctDocs) {
      const count = await this.vectorStore.countVectorsForDocument(doc.collection, doc.document_id, source.model_id);
      if (count > 0) {
        sourceKeys.add(`${doc.collection}::${doc.document_id}`);
      }
    }
    const rows =
      sourceKeys.size === 0
        ? []
        : (this.db.prepare("SELECT * FROM documents ORDER BY id ASC").all() as unknown as StoredDocument[]).filter(
            (row) => sourceKeys.has(`${row.collection}::${row.document_id}`),
          );
    await this.embedAndStoreDocuments(rows, target);
    return {
      from_key: fromKey,
      to_key: toKey,
      migrated_chunks: rows.length,
    };
  }

  async indexDocument(input: GenericVectorRequest): Promise<Record<string, unknown>> {
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
    const result = await this.indexTextDocument({
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

  async deleteDocument(collectionName: string, documentId: string): Promise<Record<string, unknown>> {
    if (this.vectorStore) {
      await this.vectorStore.deleteDocument(collectionName, documentId);
    }
    const deletedChunks = this.deleteDocumentRows(collectionName, documentId);
    return {
      message: `文档 ${documentId} 已从集合 ${collectionName} 中删除`,
      collection: collectionName,
      document_id: documentId,
      deleted_chunks: deletedChunks,
    };
  }

  async deleteCollection(collectionName: string): Promise<Record<string, unknown>> {
    if (this.vectorStore) {
      await this.vectorStore.deleteCollection(collectionName);
    }
    const deletedChunks = this.deleteCollectionRows(collectionName);
    return {
      message: `集合 ${collectionName} 已删除`,
      collection: collectionName,
      deleted_chunks: deletedChunks,
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

  async vectorHealth(): Promise<Record<string, unknown>> {
    return {
      status: "healthy",
      runtime: "local",
      collections_count: this.listCollections().length,
      vectorizers_count: (await this.listVectorizers()).length,
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
      embedding_dimension: this.vectorStore?.getDimension(this.resolveActiveVectorizer().model_id) ?? 0,
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

  async search(input: SearchVectorsRequest): Promise<Record<string, unknown>> {
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
    // driver 唯一源:sqlite-vec 必须可用(runtime 启动校验);未注入时返空候选(仅防御,生产不触达)。
    const candidates = this.vectorStore
      ? await this.searchViaDriver(collectionName, query, topK, searchMode, vectorizer, input)
      : [];
    const rerank = input.rerank === true && searchMode === "hybrid";
    const results = rerank ? lexicalRerank(candidates, query) : candidates;
    const finalTopK = input.final_top_k ?? topK;
    const sliced = results.slice(0, finalTopK);
    return {
      results: sliced,
      count: sliced.length,
      collection_name: collectionName,
      query,
      search_mode: searchMode,
      rerank,
      rerank_mode: rerank ? input.rerank_mode ?? "local" : "none",
    };
  }

  /**
   * 新路径:真 embedder 嵌入 query → driver 真 ANN 召回(已带 vector_score)→ scoring.ts 补 keyword/hybrid → 排序截断。
   * driver 只召回 + vector_score;keyword/hybrid/rerank 是检索策略,留编排层(契约深合约)。
   */
  private async searchViaDriver(
    collectionName: string,
    query: string,
    topK: number,
    searchMode: "hybrid" | "vector",
    vectorizer: StoredVectorizer,
    input: SearchVectorsRequest,
  ): Promise<VectorSearchResult[]> {
    if (!this.vectorStore) {
      return [];
    }
    const vectors = await this.embedWithFallback(vectorizer, [query]);
    const queryVector = vectors[0];
    if (!queryVector) {
      return [];
    }
    const candidateLimit = input.rerank_top_k ?? Math.max(topK, 20);
    const hits = await this.vectorStore.search({
      collection: collectionName,
      model_id: vectorizer.model_id,
      query_vector: queryVector,
      top_k: candidateLimit,
      search_mode: searchMode,
      query_text: query,
    });
    return hits
      .map((hit) => {
        const keywordScore = keywordOverlapScore(query, hit.content);
        return {
          ...hit,
          keyword_score: keywordScore,
          hybrid_score: hybridScore(hit.vector_score, keywordScore),
        };
      })
      .filter((hit) => hit.vector_score > 0 || hit.keyword_score > 0)
      .sort((left, right) =>
        searchMode === "vector" ? right.vector_score - left.vector_score : right.hybrid_score - left.hybrid_score,
      )
      .slice(0, candidateLimit)
      .map(hitToSearchResult);
  }

  /** 按 active vectorizer 解析并缓存 embedder:provider_key=local 或查无 → HashFallbackEmbedder。 */
  private async resolveEmbedder(vectorizer: StoredVectorizer): Promise<IEmbedder> {
    const cached = this.embedderCache.get(vectorizer.vectorizer_key);
    if (cached) {
      return cached;
    }
    const providerKey = vectorizer.provider_key;
    const provider = providerKey && providerKey !== "local" ? this.modelAdapter.getProvider(providerKey) : null;
    const embedder = createEmbedder(provider, vectorizer.model_name);
    this.embedderCache.set(vectorizer.vectorizer_key, embedder);
    return embedder;
  }

  /**
   * embedder 嵌入,失败时该 vectorizer 降级到本地 hash 并缓存(替换原 embedder)。
   * 降级缓存保证 index/search 同一 vectorizer 用同一 embedder——避免真模型(如 1536 维)与 hash(64 维)
   * 混用导致 driver 维度冲突。生产 embedding provider 故障(网络/key/配额)时退化为可用(hash 语义无效),
   * console.warn 暴露降级,重启后缓存清、恢复真 embedder。开发期可接受;稳定环境 provider 不应故障。
   */
  private async embedWithFallback(vectorizer: StoredVectorizer, texts: string[]): Promise<number[][]> {
    const embedder = await this.resolveEmbedder(vectorizer);
    try {
      return await embedder.embed(texts);
    } catch (error) {
      console.warn(`[vector-store] embedder(${embedder.key}) 失败,vectorizer 降级 hash 重嵌:`, error);
      const fallback = new HashFallbackEmbedder();
      this.embedderCache.set(vectorizer.vectorizer_key, fallback);
      return fallback.embed(texts);
    }
  }

  async getModelStats(modelId: number): Promise<{
    vector_count: number;
    storage_size_mb: number;
    collections: Record<string, number>;
  }> {
    if (!this.vectorStore) {
      return { vector_count: 0, storage_size_mb: 0, collections: {} };
    }
    const rows = await this.vectorStore.countVectorsByModel(modelId);
    const collections = Object.fromEntries(rows.map((row) => [row.collection, row.count]));
    const vectorCount = rows.reduce((sum, row) => sum + row.count, 0);
    const dimension = this.vectorStore.getDimension(modelId) ?? 0;
    return {
      vector_count: vectorCount,
      storage_size_mb: Math.round((vectorCount * dimension * 4 / 1024 / 1024) * 100) / 100,
      collections,
    };
  }

  async getSyncStatus(collection: string): Promise<Array<{
    model_id: number;
    vectorizer_key: string;
    total_documents: number;
    synced_documents: number;
    pending_documents: number;
    sync_percentage: number;
  }>> {
    const result: Array<{
      model_id: number;
      vectorizer_key: string;
      total_documents: number;
      synced_documents: number;
      pending_documents: number;
      sync_percentage: number;
    }> = [];
    for (const vectorizer of (await this.listVectorizers()).filter((v) => v.model_id !== null)) {
      const modelId = vectorizer.model_id!;
      const totalDocuments = this.countChunks(collection);
      const synced = this.vectorStore ? await this.vectorStore.countVectors(collection, modelId) : 0;
      result.push({
        model_id: modelId,
        vectorizer_key: vectorizer.vectorizer_key,
        total_documents: totalDocuments,
        synced_documents: synced,
        pending_documents: Math.max(totalDocuments - synced, 0),
        sync_percentage: totalDocuments ? Math.round((synced / totalDocuments) * 10000) / 100 : 0,
      });
    }
    return result;
  }

  async syncModel(modelId: number, input: { collection: string; limit?: number | null | undefined }): Promise<Record<string, unknown>> {
    const vectorizer = this.getVectorizerByModelId(modelId);
    if (!vectorizer) {
      throw new VectorLibraryServiceError(`模型不存在: ${modelId}`, 404);
    }
    const collection = input.collection || "default";
    if (!this.vectorStore) {
      return { model_id: modelId, collection, synced_documents: 0 };
    }
    // driver 唯一源:找 collection 中未索引该 model_id 的文档(countVectorsForDocument==0),补嵌其 chunk。
    const distinctDocs = this.db
      .prepare("SELECT DISTINCT document_id FROM documents WHERE collection = ? ORDER BY document_id")
      .all(collection) as Array<{ document_id: string }>;
    const pendingKeys = new Set<string>();
    for (const doc of distinctDocs) {
      const count = await this.vectorStore.countVectorsForDocument(collection, doc.document_id, modelId);
      if (count === 0) {
        pendingKeys.add(doc.document_id);
      }
    }
    let rows = (this.db
      .prepare("SELECT * FROM documents WHERE collection = ? ORDER BY id ASC")
      .all(collection) as unknown as StoredDocument[]).filter((row) => pendingKeys.has(row.document_id));
    if (input.limit) {
      rows = rows.slice(0, input.limit);
    }
    await this.embedAndStoreDocuments(rows, vectorizer);
    return {
      model_id: modelId,
      collection,
      synced_documents: rows.length,
    };
  }

  private async indexTextDocument(input: {
    collection: string;
    documentId: string;
    text: string;
    metadata: Record<string, unknown>;
    vectorizer: StoredVectorizer;
    chunkSize: number;
    overlap: number;
  }): Promise<{ chunkCount: number }> {
    const chunks = chunkText(input.text, input.chunkSize, input.overlap);
    if (chunks.length === 0) {
      // 空文本:清旧后返回(driver + service 表)
      if (this.vectorStore) {
        await this.vectorStore.deleteDocument(input.collection, input.documentId);
      }
      this.deleteDocumentRows(input.collection, input.documentId);
      return { chunkCount: 0 };
    }
    if (!this.vectorStore) {
      return { chunkCount: 0 };
    }
    return this.indexViaDriver(input, chunks);
  }

  /**
   * 新路径:真 embedder 批量嵌入 → driver.upsertRecords。chunk 文本同时写 service.documents
   * (供状态查询 fileStatus/countChunks/listDocuments + 降级 search 的 content 源;5e 状态查询切 driver 后可去)。
   */
  private async indexViaDriver(
    input: {
      collection: string;
      documentId: string;
      metadata: Record<string, unknown>;
      vectorizer: StoredVectorizer;
    },
    chunks: string[],
  ): Promise<{ chunkCount: number }> {
    if (!this.vectorStore) {
      return { chunkCount: 0 };
    }
    await this.vectorStore.deleteDocument(input.collection, input.documentId);
    this.deleteDocumentRows(input.collection, input.documentId);
    // 真 embedder 批量嵌入(一次调用替逐 chunk 嵌入);失败降级 hash 并缓存,保证 index/search 维度一致。
    const vectors = await this.embedWithFallback(input.vectorizer, chunks);
    const now = new Date().toISOString();
    const insertDocument = this.db.prepare(
      `
        INSERT INTO documents
        (collection, document_id, chunk_index, content, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    );
    const records: VectorRecord[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const metadata = {
        ...input.metadata,
        document_id: input.documentId,
        chunk_index: index,
      };
      insertDocument.run(input.collection, input.documentId, index, chunk, JSON.stringify(metadata), now);
      const embedding = vectors[index] ?? [];
      records.push({
        id: "",
        doc_id: input.documentId,
        collection: input.collection,
        model_id: input.vectorizer.model_id,
        chunk_index: index,
        content: chunk,
        metadata,
        embedding,
      });
    }
    await this.vectorStore.upsertRecords(records);
    return { chunkCount: chunks.length };
  }

  /** 删 service.documents 的 chunk 行(纯 SQL,不碰 driver)。index 清旧 + deleteDocument 复用。 */
  private deleteDocumentRows(collectionName: string, documentId: string): number {
    const rows = this.db
      .prepare("SELECT id FROM documents WHERE collection = ? AND document_id = ?")
      .all(collectionName, documentId) as Array<{ id: number }>;
    this.db.prepare("DELETE FROM documents WHERE collection = ? AND document_id = ?").run(collectionName, documentId);
    return rows.length;
  }

  /** 删 service.documents 的 chunk 行 by collection(纯 SQL,不碰 driver)。 */
  private deleteCollectionRows(collectionName: string): number {
    const rows = this.db
      .prepare("SELECT id FROM documents WHERE collection = ?")
      .all(collectionName) as Array<{ id: number }>;
    this.db.prepare("DELETE FROM documents WHERE collection = ?").run(collectionName);
    return rows.length;
  }

  /**
   * 给已存在的 documents 批量补向量(真 embedder)+ 写 driver。
   * 供 migrate(源 model 的 docs 用 target embed 重嵌)/syncModel(未向量化的 docs 补嵌)复用。
   */
  private async embedAndStoreDocuments(documents: StoredDocument[], vectorizer: StoredVectorizer): Promise<void> {
    if (documents.length === 0 || !this.vectorStore) {
      return;
    }
    const store = this.vectorStore;
    const vectors = await this.embedWithFallback(vectorizer, documents.map((doc) => doc.content));
    const records: VectorRecord[] = [];
    for (const [index, doc] of documents.entries()) {
      const embedding = vectors[index] ?? [];
      records.push({
        id: "",
        doc_id: doc.document_id,
        collection: doc.collection,
        model_id: vectorizer.model_id,
        chunk_index: doc.chunk_index,
        content: doc.content,
        metadata: parseMetadata(doc.metadata),
        embedding,
      });
    }
    await store.upsertRecords(records);
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
      .run(localKey, "local", "local", "hash-embedding", "cosine", new Date().toISOString(), null, 0);
    this.activeVectorizerKey = localKey;
    this.writeSetting("active_vectorizer_key", localKey);
    return this.getStoredVectorizer(localKey)!;
  }

  private collectionInfo(collectionName: string): Record<string, unknown> {
    return {
      name: collectionName,
      total_chunks: this.countChunks(collectionName),
      document_count: this.countDocuments(collectionName),
      sample_ids: this.sampleDocumentIds(collectionName),
      vector_dimension: this.vectorStore?.getDimension(this.resolveActiveVectorizer().model_id) ?? 0,
      active_vectorizer_key: this.activeVectorizerKey,
    };
  }

  private async listFileStatusVectorizers(): Promise<FileStatusVectorizer[]> {
    return (await this.listVectorizers()).map((vectorizer) => ({
      vectorizer_key: vectorizer.vectorizer_key,
      model_name: vectorizer.model_name,
      provider_key: vectorizer.provider_key,
      dimension: vectorizer.vector_dimension ?? 0,
      model_id: vectorizer.model_id,
    }));
  }

  private async listSharedVectorizers(): Promise<VectorizerConfig[] | null> {
    const config = this.readVectorizerConfig();
    if (!config) {
      return null;
    }
    const result: VectorizerConfig[] = [];
    for (const vectorizer of config.vectorizers) {
      const model = this.getEmbeddingModelByVectorizerKey(vectorizer.vectorizer_key);
      const stats = model ? await this.getModelStats(model.id) : { vector_count: 0 };
      result.push({
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
      });
    }
    return result;
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

  private async listSharedDocumentFileStatuses(vectorizers: FileStatusVectorizer[]): Promise<VectorFileStatus[] | null> {
    if (!this.tableExists("documents")) {
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

    const result: VectorFileStatus[] = [];
    for (const row of rows) {
      const collection = String(row.collection ?? "");
      const fileId = cleanJsonExtractedString(row.file_id);
      const chunkCount = Number(row.chunk_count ?? 0);
      const status: Record<string, "已索引" | "未索引"> = {};
      for (const vectorizer of vectorizers) {
        const vectorCount = await this.countVectorsForMetadataDocument(collection, fileId, vectorizer.model_id);
        status[vectorizer.vectorizer_key] = vectorCount === chunkCount && chunkCount > 0 ? "已索引" : "未索引";
      }
      result.push({
        file_name: cleanJsonExtractedString(row.file_name) || fileId,
        file_id: fileId,
        collection,
        chunk_count: chunkCount,
        vectorizer_status: status,
      });
    }
    return result;
  }

  private async toVectorizerConfig(vectorizer: StoredVectorizer): Promise<VectorizerConfig> {
    const stats = await this.getModelStats(vectorizer.model_id);
    return {
      vectorizer_key: vectorizer.vectorizer_key,
      provider_key: vectorizer.provider_key,
      provider_type: vectorizer.provider_type,
      model_name: vectorizer.model_name,
      distance_metric: vectorizer.distance_metric,
      created_at: vectorizer.created_at,
      is_active: vectorizer.vectorizer_key === this.activeVectorizerKey,
      provider_available: vectorizer.provider_key === "local" || this.modelAdapter.hasProvider(vectorizer.provider_key),
      vector_dimension: this.vectorStore?.getDimension(vectorizer.model_id) ?? vectorizer.vector_dimension,
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

  private async countVectorsForDocument(collection: string, documentId: string, modelId: number | null): Promise<number> {
    if (modelId === null || !this.vectorStore) {
      return 0;
    }
    return this.vectorStore.countVectorsForDocument(collection, documentId, modelId);
  }

  private async countVectorsForMetadataDocument(collection: string, fileId: string, modelId: number | null): Promise<number> {
    if (modelId === null || !fileId || !this.vectorStore) {
      return 0;
    }
    return this.vectorStore.countVectorsForDocument(collection, fileId, modelId);
  }

  private defaultCollectionForFile(fileId: string): string {
    const row = this.db
      .prepare("SELECT collection FROM documents WHERE document_id = ? ORDER BY id ASC LIMIT 1")
      .get(fileId) as { collection: string } | undefined;
    return row?.collection ?? "documents";
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

      -- 5h-2:document_vectors 表已废(driver 唯一向量源);清理历史库残留表,新库不再创建。
      DROP TABLE IF EXISTS document_vectors;
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
    this.db.exec("BEGIN");
    try {
      this.db.exec(`ALTER TABLE documents RENAME TO ${quoteIdentifier(legacyDocuments)}`);
      this.createCurrentDocumentTables();
      this.copyLegacyDocuments(legacyDocuments);
      this.db.exec(`DROP TABLE ${quoteIdentifier(legacyDocuments)}`);
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

function hitToSearchResult(hit: VectorSearchHit): VectorSearchResult {
  const score = Math.round(hit.hybrid_score * 10000) / 10000;
  return {
    id: hit.id,
    doc_id: hit.doc_id,
    document_id: hit.document_id,
    collection: hit.collection,
    text: hit.content,
    content: hit.content,
    metadata: hit.metadata,
    score,
    similarity: Math.round(hit.vector_score * 10000) / 10000,
    keyword_score: Math.round(hit.keyword_score * 10000) / 10000,
    vector_score: Math.round(hit.vector_score * 10000) / 10000,
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

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
