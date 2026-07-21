import { asString } from "../../utils/guards.js";
import fs from "node:fs";

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
} from "../../contracts/knowledge/knowledge-base.js";
import type { IEmbedder, IKnowledgeConfig, IKnowledgeFileStore, IVectorStore, KnowledgeFile, StoredChunk, StoredReranker, StoredVectorizer, VectorRecord, VectorSearchHit } from "../../contracts/vector-store/index.js";
import type { ModelProviderConfig } from "../../contracts/integrations/model-adapter.js";
import type { DocumentExtractor } from "../../contracts/knowledge/document-extractor.js";
import type { ModelAdapterService } from "../integrations/model-adapter-service.js";
import { createEmbedder } from "../integrations/embedder-registry.js";
import { createReranker, type IReranker } from "../integrations/reranker-registry.js";
import { lexicalRerank } from "./rerank/lexical-rerank.js";
// 打分纯函数统一从 scoring.ts 复用(cosineSimilarity/tokenize 随 5h-2 降级路径删除,本地副本已无)。
import { hybridScore, keywordOverlapScore } from "../vector-store/scoring.js";
import { KnowledgeBaseError } from "../../contracts/knowledge/knowledge-base.js";
import { ChunkRevisionService } from "./chunk-revision-service.js";

export type KnowledgeBaseEmbedderFactory = (
  provider: ModelProviderConfig | null | undefined,
  modelName: string,
) => IEmbedder;
export type VectorLibraryRerankerFactory = (stored: StoredReranker) => IReranker;

export class KnowledgeBaseService {
  private readonly knowledgeConfig: IKnowledgeConfig;
  /** 知识库文件存储(driver):路由层 CRUD(upload/list/delete/download)直连,业务编排(indexFile/fileStatus)由本 service。 */
  public readonly knowledgeFileStore: IKnowledgeFileStore;
  private readonly vectorStore: IVectorStore;
  // 按 vectorizer_key 缓存 embedder,避免每次 search 重复解析 provider 配置。
  // 注:provider 配置(api_key 等)运行时更新后,缓存项持有旧快照——本期接受(重启生效),后续可加失效。
  private readonly embedderCache = new Map<string, IEmbedder>();
  private readonly embedderFactory: KnowledgeBaseEmbedderFactory;
  private readonly documentExtractDispatcher: DocumentExtractor;
  private readonly rerankerFactory: VectorLibraryRerankerFactory;
  private readonly chunkRevisionService: ChunkRevisionService;

  constructor(
    private readonly modelAdapter: ModelAdapterService,
    options: {
      vectorStore: IVectorStore;
      knowledgeConfig: IKnowledgeConfig;
      knowledgeFileStore: IKnowledgeFileStore;
      embedderFactory?: KnowledgeBaseEmbedderFactory | undefined;
      documentExtractDispatcher: DocumentExtractor;
      rerankerFactory?: VectorLibraryRerankerFactory | undefined;
    },
  ) {
    this.knowledgeConfig = options.knowledgeConfig;
    this.knowledgeFileStore = options.knowledgeFileStore;
    this.vectorStore = options.vectorStore;
    this.embedderFactory = options.embedderFactory ?? createEmbedder;
    this.documentExtractDispatcher = options.documentExtractDispatcher;
    this.rerankerFactory = options.rerankerFactory ?? createReranker;
    this.chunkRevisionService = new ChunkRevisionService(this.vectorStore, async (chunk) => this.listVectorizersForChunk(chunk), async (vectorizer, texts) => this.embed(vectorizer, texts));
  }

  close(): void {
    this.vectorStore.close();
  }

  async indexExternalFile(input: IndexFileRequest, file: KnowledgeFile, markdown: string): Promise<Record<string, unknown>> {
    const collection = input.collection.trim();
    const vectorizer = this.getStoredVectorizer(input.vectorizer_key.trim());
    if (!vectorizer) throw new KnowledgeBaseError(`向量化器不存在: ${input.vectorizer_key}`, 404);
    const result = await this.indexTextDocument({
      collection,
      documentId: file.id,
      markdown,
      metadata: { source: file.original_name, source_file: file.original_name, file_id: file.id, original_filename: file.original_name, mime: file.mime },
      vectorizer,
      chunkSize: readPositiveInteger((input as Record<string, unknown>).chunk_size, 500),
      overlap: readNonNegativeInteger((input as Record<string, unknown>).overlap, 50),
    });
    return { collection, file_id: file.id, vectorizer_key: vectorizer.vectorizer_key, indexed_chunks: result.chunkCount, message: `成功索引文件，生成 ${result.chunkCount} 个分块` };
  }

  async fileStatus(): Promise<VectorFileStatusResponse> {
    const vectorizers = await this.listFileStatusVectorizers();
    // driver 唯一源:vec_documents 跨 collection 聚合出每个 document_id 的位置 + chunk 数,
    // 和 knowledgeFile join(driver kb_files ↔ 已索引位置)。知识库文件不写主库 uploaded_files。
    const locations = new Map<string, { collection: string; chunk_count: number }>(
      (await this.vectorStore.listAllDocuments()).map((doc) => [
        doc.document_id,
        { collection: doc.collection, chunk_count: doc.chunk_count },
      ]),
    );
    const fileStatuses: VectorFileStatus[] = [];
    for (const file of this.knowledgeFileStore.listKnowledgeFiles()) {
      const location = locations.get(file.id);
      const collection = location?.collection ?? "documents";
      const chunkCount = location?.chunk_count ?? 0;
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
    const stored = this.knowledgeConfig.listVectorizers();
    const configs: VectorizerConfig[] = [];
    for (const v of stored) {
      configs.push(await this.toVectorizerConfig(v));
    }
    return configs;
  }

  addVectorizer(input: VectorizerCreate): Pick<VectorizerConfig, "vectorizer_key" | "vector_dimension" | "model_id"> {
    const providerKey = input.provider_key.trim();
    const modelName = input.model_name.trim();
    if (!this.modelAdapter.hasProvider(providerKey)) {
      throw new KnowledgeBaseError(`向量化器引用的 Provider 不存在: ${providerKey}`, 400);
    }
    const key = input.vectorizer_key?.trim() || normalizeVectorizerKey(providerKey, modelName);
    if (this.knowledgeConfig.getVectorizerByKey(key)) {
      throw new KnowledgeBaseError(`向量化器键已存在: ${key}`, 400);
    }
    const created = this.knowledgeConfig.createVectorizer({
      vectorizer_key: key,
      provider_key: providerKey,
      provider_type: normalizeNullableString(input.provider_type),
      model_name: modelName,
      distance_metric: input.distance_metric || "cosine",
    });
    return {
      vectorizer_key: created.vectorizer_key,
      vector_dimension: created.vector_dimension,
      model_id: created.model_id,
    };
  }

  activateVectorizer(key: string): { active_vectorizer_key: string } {
    if (!this.knowledgeConfig.getVectorizerByKey(key)) {
      throw new KnowledgeBaseError(`向量化器不存在: ${key}`, 404);
    }
    this.knowledgeConfig.activateVectorizer(key);
    return { active_vectorizer_key: key };
  }

  async deleteVectorizer(key: string): Promise<{ deleted_vectorizer_key: string }> {
    const stored = this.knowledgeConfig.getVectorizerByKey(key);
    if (!stored) {
      throw new KnowledgeBaseError(`向量化器不存在: ${key}`, 404);
    }
    // driver 内部事务包"清向量 + 删实体 + 回退 active"。
    this.knowledgeConfig.deleteVectorizer(key);
    return { deleted_vectorizer_key: key };
  }

  async listDocsByVectorizer(key: string): Promise<Array<Record<string, unknown>>> {
    const vectorizer = this.getStoredVectorizer(key);
    if (!vectorizer) {
      throw new KnowledgeBaseError(`向量化器不存在或未在 DB 注册: ${key}`, 404);
    }
    // driver 唯一源:listAllDocuments 跨 collection 列文档,按 model_id 过滤该 vectorizer 实际索引的 + 计向量数。
    const docs = await this.vectorStore.listAllDocuments();
    const result: Array<Record<string, unknown>> = [];
    for (const doc of docs) {
      const vectorCount = await this.vectorStore.countVectorsForDocument(doc.collection, doc.document_id, vectorizer.model_id);
      if (vectorCount > 0) {
        result.push({
          document_id: doc.document_id,
          collection: doc.collection,
          vector_count: vectorCount,
          metadata: doc.metadata ?? {},
        });
      }
    }
    return result;
  }

  /** 抽取并落库 canonical Markdown（extract + putKnowledgeMarkdown），返回 MD。 */
  private async extractAndStoreMarkdown(file: KnowledgeFile): Promise<string> {
    const extracted = await this.documentExtractDispatcher.extract({ file_path: file.stored_path, file_name: file.original_name, mime: file.mime });
    this.knowledgeFileStore.putKnowledgeMarkdown(file.id, extracted.markdown);
    return extracted.markdown;
  }

  /**
   * 上传后即生成 canonical Markdown（预览/索引基础），与 embedding 解耦。
   * routes upload 调：文件上传后立即可预览，无需先索引。
   */
  async generateMarkdownForFile(fileId: string): Promise<void> {
    const file = this.knowledgeFileStore.getKnowledgeFile(fileId);
    if (!file) {
      throw new KnowledgeBaseError(`文件不存在: ${fileId}`, 404);
    }
    if (!fs.existsSync(file.stored_path)) {
      throw new KnowledgeBaseError(`文件路径无效: ${file.stored_path}`, 404);
    }
    await this.extractAndStoreMarkdown(file);
  }

  async updateMarkdown(fileId: string, content: string): Promise<{ md_blob_hash: string; indexed_chunks: number }> {
    const file = this.knowledgeFileStore.getKnowledgeFile(fileId);
    if (!file) throw new KnowledgeBaseError(`文件不存在: ${fileId}`, 404);
    const locations = (await this.vectorStore.listAllDocuments()).filter((doc) => doc.document_id === fileId);
    const targets: Array<{ collection: string; vectorizer: StoredVectorizer }> = [];
    for (const location of locations) for (const vectorizer of this.knowledgeConfig.listVectorizers()) if (await this.vectorStore.countVectorsForDocument(location.collection, fileId, vectorizer.model_id)) targets.push({ collection: location.collection, vectorizer });
    await this.vectorStore.deleteDocumentVectors(fileId);
    const stored = this.knowledgeFileStore.putKnowledgeMarkdown(fileId, content);
    let indexedChunks = 0;
    for (const target of targets) {
      const result = await this.indexTextDocument({ collection: target.collection, documentId: file.id, markdown: content, metadata: { source: file.original_name, source_file: file.original_name, file_id: file.id, original_filename: file.original_name, mime: file.mime }, vectorizer: target.vectorizer, chunkSize: 500, overlap: 50 });
      indexedChunks = Math.max(indexedChunks, result.chunkCount);
    }
    return { md_blob_hash: stored.md_blob_hash, indexed_chunks: indexedChunks };
  }

  async listFileChunks(fileId: string): Promise<StoredChunk[]> {
    if (!this.knowledgeFileStore.getKnowledgeFile(fileId)) throw new KnowledgeBaseError(`文件不存在: ${fileId}`, 404);
    return (await this.vectorStore.listChunks()).filter((chunk) => chunk.document_id === fileId);
  }

  async updateChunk(fileId: string, chunkId: number, content: string): Promise<StoredChunk> {
    return this.chunkRevisionService.updateContent(fileId, chunkId, content);
  }

  /** 索引时解析 MD：优先已存（upload 生成），无则 extract 生成（兼容老文件/blob 损坏）。 */
  private async resolveMarkdown(file: KnowledgeFile): Promise<string> {
    if (file.md_blob_hash) {
      try {
        return this.knowledgeFileStore.readKnowledgeMarkdown(file.md_blob_hash);
      } catch {
        // blob 损坏/缺失，fall through 重新生成
      }
    }
    return this.extractAndStoreMarkdown(file);
  }

  async indexFile(input: IndexFileRequest): Promise<Record<string, unknown>> {
    const collection = input.collection.trim();
    const fileId = input.file_id.trim();
    const vectorizer = this.getStoredVectorizer(input.vectorizer_key.trim());
    if (!vectorizer) {
      throw new KnowledgeBaseError(`向量化器不存在: ${input.vectorizer_key}`, 404);
    }
    const file = this.knowledgeFileStore.getKnowledgeFile(fileId);
    if (!file) {
      throw new KnowledgeBaseError(`文件不存在: ${fileId}`, 404);
    }
    if (!fs.existsSync(file.stored_path)) {
      throw new KnowledgeBaseError(`文件路径无效: ${file.stored_path}`, 404);
    }
    const markdown = await this.resolveMarkdown(file);
    const result = await this.indexTextDocument({
      collection,
      documentId: file.id,
      markdown,
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

  /**
   * 删除知识库文件并联动清向量:先按 document_id(= file.id)跨 collection 删全部已索引向量(幂等),
   * 再删 kb_files 行 + 物理 blob。顺序保证向量删失败时文件保留、可重试,不留半删态/孤儿向量。
   * 文件不存在返回 null(路由据此 404)。供 /api/knowledge-bases/files/:fileId DELETE 调用。
   */
  async deleteKnowledgeFileWithVectors(
    fileId: string,
  ): Promise<{ file: KnowledgeFile; deleted_chunks: number } | null> {
    const file = this.knowledgeFileStore.getKnowledgeFile(fileId);
    if (!file) {
      return null;
    }
    const deleted_chunks = (await this.vectorStore.deleteDocumentVectors(fileId)).deleted_chunks;
    this.knowledgeFileStore.deleteKnowledgeFile(fileId);
    return { file, deleted_chunks };
  }

  async migrate(input: GenericVectorRequest): Promise<Record<string, unknown>> {
    const payload = input ?? {};
    const fromKey = asString(payload.from_key) ?? asString(payload.fromKey);
    const toKey = asString(payload.to_key) ?? asString(payload.toKey);
    if (!fromKey || !toKey) {
      throw new KnowledgeBaseError("缺少 from_key 或 to_key", 400);
    }
    const source = this.getStoredVectorizer(fromKey);
    const target = this.getStoredVectorizer(toKey);
    if (!source || !target) {
      throw new KnowledgeBaseError("源或目标向量化器不存在", 404);
    }
    // driver 唯一源:listAllDocuments 找 source model 已索引的文档(countVectorsForDocument>0),
    // listChunks 取这些文档的全部 chunk 用 target 重嵌。无主库 documents 文本源。
    const allDocs = await this.vectorStore.listAllDocuments();
    const sourceKeys = new Set<string>();
    for (const doc of allDocs) {
      const count = await this.vectorStore.countVectorsForDocument(doc.collection, doc.document_id, source.model_id);
      if (count > 0) {
        sourceKeys.add(`${doc.collection}::${doc.document_id}`);
      }
    }
    const chunks = sourceKeys.size === 0 ? [] : (await this.vectorStore.listChunks()).filter((chunk) =>
      sourceKeys.has(`${chunk.collection}::${chunk.document_id}`),
    );
    await this.embedAndStoreDocuments(chunks, target);
    return {
      from_key: fromKey,
      to_key: toKey,
      migrated_chunks: chunks.length,
    };
  }

  async indexDocument(input: GenericVectorRequest): Promise<Record<string, unknown>> {
    const payload = input ?? {};
    const collection = asString(payload.collection_name) ?? asString(payload.collection) ?? "documents";
    let documentId = asString(payload.document_id) ?? "";
    const chunkSize = readPositiveInteger(payload.chunk_size, 500);
    const overlap = readNonNegativeInteger(payload.overlap, 50);
    let markdown = asString(payload.markdown) ?? asString(payload.text) ?? "";
    const metadata = asRecord(payload.metadata);
    const fileId = asString(payload.file_id);
    if (fileId) {
      const file = this.knowledgeFileStore.getKnowledgeFile(fileId);
      if (!file) {
        throw new KnowledgeBaseError(`文件不存在: ${fileId}`, 404);
      }
      if (!fs.existsSync(file.stored_path)) {
        throw new KnowledgeBaseError(`文件路径无效: ${file.stored_path}`, 404);
      }
      markdown = await this.resolveMarkdown(file);
      documentId = documentId || file.id;
      metadata.source = metadata.source ?? file.original_name;
      metadata.source_file = metadata.source_file ?? file.original_name;
      metadata.file_id = file.id;
      metadata.original_filename = file.original_name;
    }
    if (!documentId || !markdown) {
      throw new KnowledgeBaseError("document_id和 Markdown 内容不能为空", 400);
    }
    const vectorizer = this.resolveActiveVectorizer();
    const result = await this.indexTextDocument({
      collection,
      documentId,
      markdown,
      metadata,
      vectorizer,
      chunkSize,
      overlap,
    });
    return {
      document_id: documentId,
      indexed_chunks: result.chunkCount,
      collection_name: collection,
      stats: await this.collectionInfo(collection),
      message: `成功索引文档，生成 ${result.chunkCount} 个分块`,
    };
  }

  async deleteDocument(collectionName: string, documentId: string): Promise<Record<string, unknown>> {
    const { deleted_chunks } = await this.vectorStore.deleteDocument(collectionName, documentId);
    return {
      message: `文档 ${documentId} 已从集合 ${collectionName} 中删除`,
      collection: collectionName,
      document_id: documentId,
      deleted_chunks,
    };
  }

  async deleteCollection(collectionName: string): Promise<Record<string, unknown>> {
    const { deleted_chunks } = await this.vectorStore.deleteCollection(collectionName);
    return {
      message: `集合 ${collectionName} 已删除`,
      collection: collectionName,
      deleted_chunks,
    };
  }

  listRerankers(): RerankerConfig[] {
    return this.knowledgeConfig.listRerankers().map((r) => this.toRerankerConfig(r));
  }

  addReranker(input: RerankerCreate): { reranker_key: string } {
    const mode = normalizeRerankerMode(input.mode);
    const providerKey = input.provider_key?.trim() || "";
    const modelName = input.model_name?.trim() || "";
    if (mode === "model") {
      if (!providerKey || !modelName) {
        throw new KnowledgeBaseError("model 模式的重排序器必须提供 provider_key 和 model_name", 400);
      }
      if (!input.api_endpoint?.trim()) {
        throw new KnowledgeBaseError("model 模式的重排序器必须提供 api_endpoint", 400);
      }
    }
    const key = input.reranker_key?.trim() || normalizeRerankerKey(mode, providerKey, modelName);
    if (this.knowledgeConfig.getReranker(key)) {
      throw new KnowledgeBaseError(`重排序器键已存在: ${key}`, 400);
    }
    this.knowledgeConfig.createReranker({
      reranker_key: key,
      mode,
      provider_key: providerKey,
      provider_type: normalizeNullableString(input.provider_type),
      model_name: modelName,
      api_endpoint: input.api_endpoint?.trim() || "",
      api_key: input.api_key ?? null,
    });
    return { reranker_key: key };
  }

  getReranker(key: string): RerankerConfig | null {
    const reranker = this.knowledgeConfig.getReranker(key);
    return reranker ? this.toRerankerConfig(reranker) : null;
  }

  activateReranker(key: string): { active_reranker_key: string } {
    if (!this.knowledgeConfig.getReranker(key)) {
      throw new KnowledgeBaseError(`重排序器不存在: ${key}`, 404);
    }
    this.knowledgeConfig.activateReranker(key);
    return { active_reranker_key: key };
  }

  deleteReranker(key: string): { deleted_reranker_key: string } {
    if (!this.knowledgeConfig.getReranker(key)) {
      throw new KnowledgeBaseError(`重排序器不存在: ${key}`, 404);
    }
    this.knowledgeConfig.deleteReranker(key);
    return { deleted_reranker_key: key };
  }

  async vectorHealth(): Promise<Record<string, unknown>> {
    const vectorizers = this.knowledgeConfig.listVectorizers();
    const rerankers = this.knowledgeConfig.listRerankers();
    return {
      status: "healthy",
      runtime: "local",
      collections_count: (await this.listCollections()).length,
      vectorizers_count: vectorizers.length,
      rerankers_count: rerankers.length,
      active_vectorizer_key: vectorizers.find((v) => v.is_active)?.vectorizer_key ?? null,
      active_reranker_key: rerankers.find((r) => r.is_active)?.reranker_key ?? null,
    };
  }

  async listCollections(): Promise<Array<Record<string, unknown>>> {
    // driver 唯一源:vec_documents 跨 collection 聚合。collections 表分支(主库从不建)已删。
    const collections = await this.vectorStore.listCollections();
    const active = this.resolveActiveVectorizer();
    return collections.map((row) => ({
      name: row.name,
      total_chunks: row.total_chunks,
      chunk_count: row.total_chunks,
      document_count: row.document_count,
      embedding_dimension: row.embedding_dimension ?? 0,
      model_name: active.model_name,
      metadata: {
        document_count: row.document_count,
      },
    }));
  }

  async listDocuments(collectionName: string): Promise<Record<string, unknown>> {
    const docs = await this.vectorStore.listDocuments(collectionName);
    return {
      collection_name: collectionName,
      total_chunks: docs.reduce((sum, doc) => sum + doc.chunk_count, 0),
      sample_ids: docs.map((doc) => doc.document_id).slice(0, 20),
      info: await this.collectionInfo(collectionName),
    };
  }

  async search(input: SearchVectorsRequest): Promise<Record<string, unknown>> {
    const collectionName = input.collection_name?.trim() || input.collection?.trim() || "documents";
    const query = input.query.trim();
    const topK = input.top_k ?? 5;
    const searchMode = input.search_mode ?? input.mode ?? "hybrid";
    if (!query) {
      throw new KnowledgeBaseError("查询内容不能为空", 400);
    }
    if (searchMode !== "hybrid" && searchMode !== "vector") {
      throw new KnowledgeBaseError("search_mode 只能是 hybrid 或 vector", 400);
    }
    const vectorizer = this.resolveActiveVectorizer();
    const candidates = await this.searchViaDriver(collectionName, query, topK, searchMode, vectorizer, input);
    const activeReranker = this.knowledgeConfig.listRerankers().find((stored) => stored.is_active) ?? null;
    const reranker = input.rerank !== false && activeReranker && searchMode === "hybrid" ? this.rerankerFactory(activeReranker) : null;
    let results = candidates;
    let rerankMode: "model" | "lexical" | "none" | "degraded" = "none";
    if (reranker) {
      try {
        const reranked = await reranker.rerank(query, candidates);
        results = reranked.results;
        rerankMode = reranked.mode;
      } catch (error) {
        console.warn({ event: "reranker_degraded", reranker_key: activeReranker!.reranker_key, error: error instanceof Error ? error.message : String(error) });
        results = lexicalRerank(candidates, query).map((result) => ({ ...result, rerank_degraded: true }));
        rerankMode = "degraded";
      }
    }
    const finalTopK = input.final_top_k ?? topK;
    const sliced = results.slice(0, finalTopK);
    return {
      results: sliced,
      count: sliced.length,
      collection_name: collectionName,
      query,
      search_mode: searchMode,
      rerank: reranker !== null,
      rerank_mode: rerankMode,
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
    const vectors = await this.embed(vectorizer, [query]);
    const queryVector = vectors[0];
    if (!queryVector) {
      return [];
    }
    const candidateLimit = input.rerank_top_k ?? Math.max(topK, 20);
    const hits: VectorSearchHit[] = await this.vectorStore.search({
        collection: collectionName, model_id: vectorizer.model_id, query_vector: queryVector,
        top_k: candidateLimit, search_mode: searchMode, query_text: query,
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
    const embedder = this.embedderFactory(provider, vectorizer.model_name);
    this.embedderCache.set(vectorizer.vectorizer_key, embedder);
    return embedder;
  }

  /** 远端 provider 失败时显式失败，禁止把无效 hash 向量伪装成成功的语义索引。 */
  private async embed(vectorizer: StoredVectorizer, texts: string[]): Promise<number[][]> {
    const embedder = await this.resolveEmbedder(vectorizer);
    return embedder.embed(texts);
  }

  async getModelStats(modelId: number): Promise<{
    vector_count: number;
    storage_size_mb: number;
    collections: Record<string, number>;
  }> {
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
      const totalDocuments = await this.vectorStore.countChunks(collection);
      const synced = await this.vectorStore.countVectors(collection, modelId);
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
      throw new KnowledgeBaseError(`模型不存在: ${modelId}`, 404);
    }
    const collection = input.collection || "default";
    // driver 唯一源:collection 中 countVectorsForDocument==0 的文档(未索引该 model_id),listChunks 取其 chunk 补嵌。
    const docs = (await this.vectorStore.listAllDocuments()).filter((doc) => doc.collection === collection);
    const pendingKeys = new Set<string>();
    for (const doc of docs) {
      const count = await this.vectorStore.countVectorsForDocument(collection, doc.document_id, modelId);
      if (count === 0) {
        pendingKeys.add(doc.document_id);
      }
    }
    let chunks = (await this.vectorStore.listChunks(collection)).filter((chunk) => pendingKeys.has(chunk.document_id));
    if (input.limit) {
      chunks = chunks.slice(0, input.limit);
    }
    await this.embedAndStoreDocuments(chunks, vectorizer);
    return {
      model_id: modelId,
      collection,
      synced_documents: chunks.length,
    };
  }

  private async indexTextDocument(input: {
    collection: string;
    documentId: string;
    markdown: string;
    metadata: Record<string, unknown>;
    vectorizer: StoredVectorizer;
    chunkSize: number;
    overlap: number;
  }): Promise<{ chunkCount: number }> {
    const chunks = chunkMarkdown(input.markdown, input.chunkSize, input.overlap);
    if (chunks.length === 0) {
      // 空文本:driver 清旧后返回。
      await this.vectorStore.deleteDocument(input.collection, input.documentId);
      return { chunkCount: 0 };
    }
    return this.indexViaDriver(input, chunks);
  }

  /**
   * 真 embedder 批量嵌入 → driver.upsertRecords(driver 唯一文本+向量源)。无主库 documents 双写。
   */
  private async indexViaDriver(
    input: {
      collection: string;
      documentId: string;
      metadata: Record<string, unknown>;
      vectorizer: StoredVectorizer;
    },
    chunks: MarkdownChunk[],
  ): Promise<{ chunkCount: number }> {
    // 重索引幂等:只清当前 vectorizer(model_id) 下该 document 的向量,不动其他 vectorizer 的向量
    // (一文件可被多 vectorizer 索引,向量按 model 分表)。约定:同文件多 vectorizer 必须相同 chunk 划分,
    // 否则共享 chunk 文本(vec_documents,UNIQUE 不含 model_id)会被后索引者覆盖污染。
    await this.vectorStore.deleteDocumentVectorsByModel(input.collection, input.documentId, input.vectorizer.model_id);
    // 真 embedder 批量嵌入（一次调用替代逐 chunk 嵌入）；provider 失败时直接终止索引。
    const vectors = await this.embed(input.vectorizer, chunks.map((chunk) => chunk.content));
    const records: VectorRecord[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const metadata = {
        ...input.metadata,
        document_id: input.documentId,
        chunk_index: index,
        char_start: chunk.charStart,
        char_end: chunk.charEnd,
        heading_path: chunk.headingPath,
      };
      records.push({
        id: "",
        doc_id: input.documentId,
        collection: input.collection,
        model_id: input.vectorizer.model_id,
        chunk_index: index,
        content: chunk.content,
        metadata,
        embedding: vectors[index] ?? [],
      });
    }
    await this.vectorStore.upsertRecords(records);
    return { chunkCount: chunks.length };
  }

  /**
   * 已有 chunk 批量重嵌(真 embedder)+ 写 driver。
   * 供 migrate(源 model 的 chunks 用 target embed 重嵌)/syncModel(未向量化的 chunks 补嵌)复用。
   */
  private async embedAndStoreDocuments(chunks: StoredChunk[], vectorizer: StoredVectorizer): Promise<void> {
    if (chunks.length === 0) {
      return;
    }
    const vectors = await this.embed(vectorizer, chunks.map((chunk) => chunk.content));
    const records: VectorRecord[] = [];
    for (const [index, chunk] of chunks.entries()) {
      records.push({
        id: "",
        doc_id: chunk.document_id,
        collection: chunk.collection,
        model_id: vectorizer.model_id,
        chunk_index: chunk.chunk_index,
        content: chunk.content,
        metadata: chunk.metadata,
        embedding: vectors[index] ?? [],
      });
    }
    await this.vectorStore.upsertRecords(records);
  }

  private async listVectorizersForChunk(chunk: StoredChunk): Promise<StoredVectorizer[]> {
    const result: StoredVectorizer[] = [];
    for (const vectorizer of this.knowledgeConfig.listVectorizers()) if (await this.vectorStore.countVectorsForDocument(chunk.collection, chunk.document_id, vectorizer.model_id)) result.push(vectorizer);
    return result;
  }

  private resolveActiveVectorizer(): StoredVectorizer {
    const all = this.knowledgeConfig.listVectorizers();
    const active = all.find((v) => v.is_active);
    if (active) {
      return active;
    }
    if (all.length > 0) {
      // 无 active 标记时回退到首个(不应该发生,partial UNIQUE 保证有则唯一)。
      return all[0] as StoredVectorizer;
    }
    // 空表自动建 local_hash_embedding(向后兼容:无 provider 配置也能跑 hash)。
    const localKey = "local_hash_embedding";
    return this.knowledgeConfig.createVectorizer({
      vectorizer_key: localKey,
      provider_key: "local",
      provider_type: "local",
      model_name: "hash-embedding",
      distance_metric: "cosine",
    });
  }

  private async collectionInfo(collectionName: string): Promise<Record<string, unknown>> {
    const active = this.resolveActiveVectorizer();
    const all = this.knowledgeConfig.listVectorizers();
    const docs = await this.vectorStore.listDocuments(collectionName);
    return {
      name: collectionName,
      total_chunks: docs.reduce((sum, doc) => sum + doc.chunk_count, 0),
      document_count: docs.length,
      sample_ids: docs.map((doc) => doc.document_id),
      vector_dimension: this.vectorStore.getDimension(active.model_id) ?? 0,
      active_vectorizer_key: all.find((v) => v.is_active)?.vectorizer_key ?? active.vectorizer_key,
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

  private async toVectorizerConfig(vectorizer: StoredVectorizer): Promise<VectorizerConfig> {
    const stats = await this.getModelStats(vectorizer.model_id);
    return {
      vectorizer_key: vectorizer.vectorizer_key,
      provider_key: vectorizer.provider_key,
      provider_type: vectorizer.provider_type,
      model_name: vectorizer.model_name,
      distance_metric: vectorizer.distance_metric,
      created_at: vectorizer.created_at,
      is_active: vectorizer.is_active,
      provider_available: vectorizer.provider_key === "local" || this.modelAdapter.hasProvider(vectorizer.provider_key),
      vector_dimension: this.vectorStore.getDimension(vectorizer.model_id) ?? vectorizer.vector_dimension,
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
      is_active: reranker.is_active,
      api_key_set: Boolean(reranker.api_key),
    };
    return config;
  }

  private getStoredVectorizer(key: string): StoredVectorizer | null {
    return this.knowledgeConfig.getVectorizerByKey(key);
  }

  private getVectorizerByModelId(modelId: number): StoredVectorizer | null {
    return this.knowledgeConfig.getVectorizerByModelId(modelId);
  }

  private getStoredReranker(key: string): StoredReranker | null {
    return this.knowledgeConfig.getReranker(key);
  }

  private async countVectorsForDocument(collection: string, documentId: string, modelId: number | null): Promise<number> {
    if (modelId === null) {
      return 0;
    }
    return this.vectorStore.countVectorsForDocument(collection, documentId, modelId);
  }
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

interface MarkdownChunk {
  content: string;
  charStart: number;
  charEnd: number;
  headingPath: string;
}

function chunkMarkdown(markdown: string, chunkSize: number, overlap: number): MarkdownChunk[] {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }
  const safeChunkSize = Math.max(1, chunkSize);
  const safeOverlap = Math.min(Math.max(0, overlap), Math.max(0, safeChunkSize - 1));
  const sections = splitMarkdownSections(normalized);
  const chunks: MarkdownChunk[] = [];
  for (const section of sections) {
    let start = section.start;
    while (start < section.end) {
      const end = Math.min(start + safeChunkSize, section.end);
      chunks.push({ content: normalized.slice(start, end), charStart: start, charEnd: end, headingPath: section.headingPath });
      if (end === section.end) break;
      start = end - safeOverlap;
    }
  }
  return chunks;
}

function splitMarkdownSections(markdown: string): Array<{ start: number; end: number; headingPath: string }> {
  const headings: string[] = [];
  const sections: Array<{ start: number; end: number; headingPath: string }> = [];
  const matches = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  if (matches.length === 0) return [{ start: 0, end: markdown.length, headingPath: "" }];
  if ((matches[0]?.index ?? 0) > 0) sections.push({ start: 0, end: matches[0]?.index ?? 0, headingPath: "" });
  for (const [index, match] of matches.entries()) {
    const level = match[1]?.length ?? 1;
    headings.length = level - 1;
    headings[level - 1] = match[2]?.trim() ?? "";
    sections.push({ start: match.index ?? 0, end: matches[index + 1]?.index ?? markdown.length, headingPath: headings.filter(Boolean).join(">") });
  }
  return sections.filter((section) => section.end > section.start);
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



function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}
