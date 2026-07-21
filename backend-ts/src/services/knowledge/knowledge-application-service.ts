import type { AsyncKnowledgeConfigStore } from "../../contracts/knowledge/async-knowledge-config.js";
import type { AsyncKnowledgeVectorStore } from "../../contracts/knowledge/async-vector-store.js";
import type { GenericVectorRequest, IndexFileRequest, RerankerConfig, RerankerCreate, SearchVectorsRequest, VectorFileStatusResponse, VectorizerConfig, VectorizerCreate, VectorSearchResult } from "../../contracts/knowledge/knowledge-base.js";
import type { KnowledgeCollectionSummary, KnowledgeQueryPort, KnowledgeSearchResponse } from "../../contracts/knowledge/query-port.js";
import type { KnowledgeFile } from "../../contracts/vector-store/knowledge-file-store.js";
import type { StoredReranker, StoredVectorizer } from "../../contracts/vector-store/knowledge-config.js";
import type { IEmbedder } from "../../contracts/vector-store/embedder.js";
import type { ModelProviderConfig } from "../../contracts/integrations/model-adapter.js";
import type { ModelAdapterService } from "../integrations/model-adapter-service.js";
import { createEmbedder } from "../integrations/embedder-registry.js";
import { createReranker, type IReranker } from "../integrations/reranker-registry.js";
import { lexicalRerank } from "./rerank/lexical-rerank.js";
import { hybridScore, keywordOverlapScore } from "../vector-store/scoring.js";
import { KnowledgeBaseError } from "../../contracts/knowledge/knowledge-base.js";

export type KnowledgeEmbedderFactory = (
  provider: ModelProviderConfig | null | undefined,
  modelName: string,
) => IEmbedder;

export type KnowledgeRerankerFactory = (stored: StoredReranker) => IReranker;

/** Deployment-neutral knowledge orchestration over tenant-scoped storage ports. */
export class KnowledgeApplicationService implements KnowledgeQueryPort {
  private readonly embedderCache = new Map<string, IEmbedder>();
  private readonly embedderFactory: KnowledgeEmbedderFactory;
  private readonly rerankerFactory: KnowledgeRerankerFactory;

  constructor(
    private readonly tenantId: string,
    private readonly modelAdapter: ModelAdapterService,
    private readonly config: AsyncKnowledgeConfigStore,
    private readonly vectors: AsyncKnowledgeVectorStore,
    embedderFactory: KnowledgeEmbedderFactory = createEmbedder,
    rerankerFactory: KnowledgeRerankerFactory = createReranker,
  ) {
    this.embedderFactory = embedderFactory;
    this.rerankerFactory = rerankerFactory;
  }

  async listCollections(): Promise<KnowledgeCollectionSummary[]> {
    const [collections, vectorizers] = await Promise.all([
      this.vectors.listCollections(this.tenantId),
      this.config.listVectorizers(this.tenantId),
    ]);
    const active = vectorizers.find((item) => item.is_active) ?? vectorizers[0];
    return collections.map((row) => ({
      name: row.name, document_count: row.document_count, chunk_count: row.chunk_count, total_chunks: row.total_chunks,
      embedding_dimension: row.embedding_dimension ?? 0,
      model_name: active?.model_name ?? "",
      metadata: { document_count: row.document_count },
    }));
  }

  async listVectorizers(): Promise<VectorizerConfig[]> {
    return Promise.all((await this.config.listVectorizers(this.tenantId)).map((vectorizer) => this.toVectorizerConfig(vectorizer)));
  }

  async fileStatus(files: KnowledgeFile[]): Promise<VectorFileStatusResponse> {
    const [vectorizers, indexes] = await Promise.all([
      this.listVectorizers(),
      this.vectors.listDocumentIndexes(this.tenantId),
    ]);
    const statusVectorizers = vectorizers.map((vectorizer) => ({
      vectorizer_key: vectorizer.vectorizer_key,
      model_name: vectorizer.model_name,
      provider_key: vectorizer.provider_key,
      dimension: vectorizer.vector_dimension ?? 0,
      model_id: vectorizer.model_id,
    }));
    const fileStatuses = files.flatMap((file) => {
      const fileIndexes = indexes.filter((index) => index.document_id === file.id);
      const collection = [...new Set(fileIndexes.map((index) => index.collection))].sort().at(-1) ?? "documents";
      const collectionIndexes = fileIndexes.filter((index) => index.collection === collection);
      const chunkCount = Math.max(0, ...collectionIndexes.map((index) => index.chunk_count));
      const vectorizerStatus: Record<string, "已索引" | "未索引"> = {};
      for (const vectorizer of statusVectorizers) {
        const indexed = collectionIndexes.find((index) => index.model_id === vectorizer.model_id);
        vectorizerStatus[vectorizer.vectorizer_key] = indexed && indexed.chunk_count >= chunkCount && chunkCount > 0 ? "已索引" : "未索引";
      }
      return [{
        file_name: file.original_name,
        file_id: file.id,
        collection,
        chunk_count: chunkCount,
        vectorizer_status: vectorizerStatus,
        uploaded_at: file.uploaded_at,
        size: file.size,
        mime: file.mime,
      }];
    });
    return { files: fileStatuses, vectorizers: statusVectorizers };
  }

  async listRerankers(): Promise<RerankerConfig[]> {
    return (await this.config.listRerankers(this.tenantId)).map(toRerankerConfig);
  }

  async addReranker(input: RerankerCreate): Promise<{ reranker_key: string }> {
    const mode = normalizeRerankerMode(input.mode);
    const providerKey = input.provider_key?.trim() || "";
    const modelName = input.model_name?.trim() || "";
    if (mode === "model") {
      if (!providerKey || !modelName) throw new KnowledgeBaseError("model 模式的重排序器必须提供 provider_key 和 model_name", 400);
      if (!input.api_endpoint?.trim()) throw new KnowledgeBaseError("model 模式的重排序器必须提供 api_endpoint", 400);
    }
    const key = input.reranker_key?.trim() || normalizeRerankerKey(mode, providerKey, modelName);
    if (await this.config.getReranker(this.tenantId, key)) throw new KnowledgeBaseError(`重排序器键已存在: ${key}`, 400);
    await this.config.createReranker(this.tenantId, {
      reranker_key: key, mode, provider_key: providerKey, provider_type: input.provider_type?.trim() || null,
      model_name: modelName, api_endpoint: input.api_endpoint?.trim() || "", api_key: input.api_key ?? null,
    });
    return { reranker_key: key };
  }

  async getReranker(key: string): Promise<RerankerConfig | null> {
    const reranker = await this.config.getReranker(this.tenantId, key);
    return reranker ? toRerankerConfig(reranker) : null;
  }

  async activateReranker(key: string): Promise<{ active_reranker_key: string }> {
    if (!await this.getReranker(key)) throw new KnowledgeBaseError(`重排序器不存在: ${key}`, 404);
    await this.config.activateReranker(this.tenantId, key);
    return { active_reranker_key: key };
  }

  async deleteReranker(key: string): Promise<{ deleted_reranker_key: string }> {
    if (!await this.getReranker(key)) throw new KnowledgeBaseError(`重排序器不存在: ${key}`, 404);
    await this.config.deleteReranker(this.tenantId, key);
    return { deleted_reranker_key: key };
  }

  async addVectorizer(input: VectorizerCreate): Promise<Pick<VectorizerConfig, "vectorizer_key" | "vector_dimension" | "model_id">> {
    const providerKey = input.provider_key.trim();
    if (providerKey !== "local" && !this.modelAdapter.hasProvider(providerKey)) throw new KnowledgeBaseError(`向量化器引用的 Provider 不存在: ${providerKey}`, 400);
    const modelName = input.model_name.trim();
    const key = input.vectorizer_key?.trim() || `${providerKey}_${modelName.replace(/[^\w.-]/g, "_").slice(0, 120)}`;
    if (await this.config.getVectorizerByKey(this.tenantId, key)) throw new KnowledgeBaseError(`向量化器键已存在: ${key}`, 400);
    const created = await this.config.createVectorizer(this.tenantId, { vectorizer_key: key, provider_key: providerKey, provider_type: input.provider_type ?? null, model_name: modelName, distance_metric: input.distance_metric || "cosine" });
    return { vectorizer_key: created.vectorizer_key, vector_dimension: created.vector_dimension, model_id: created.model_id };
  }

  async activateVectorizer(key: string): Promise<{ active_vectorizer_key: string }> {
    if (!await this.config.getVectorizerByKey(this.tenantId, key)) throw new KnowledgeBaseError(`向量化器不存在: ${key}`, 404);
    await this.config.activateVectorizer(this.tenantId, key);
    return { active_vectorizer_key: key };
  }

  async deleteVectorizer(key: string): Promise<{ deleted_vectorizer_key: string }> {
    const vectorizer = await this.config.getVectorizerByKey(this.tenantId, key);
    if (!vectorizer) throw new KnowledgeBaseError(`向量化器不存在: ${key}`, 404);
    await this.vectors.deleteChunks({ tenant_id: this.tenantId, model_id: vectorizer.model_id });
    await this.config.deleteVectorizer(this.tenantId, key);
    return { deleted_vectorizer_key: key };
  }

  async listDocsByVectorizer(key: string): Promise<Array<Record<string, unknown>>> {
    const vectorizer = await this.config.getVectorizerByKey(this.tenantId, key);
    if (!vectorizer) throw new KnowledgeBaseError(`向量化器不存在或未在 DB 注册: ${key}`, 404);
    const [indexes, documents] = await Promise.all([
      this.vectors.listDocumentIndexes(this.tenantId),
      this.vectors.listAllDocuments(this.tenantId),
    ]);
    const metadata = new Map(documents.map((document) => [`${document.collection}\u0000${document.document_id}`, document.metadata ?? {}]));
    return indexes.filter((index) => index.model_id === vectorizer.model_id && index.chunk_count > 0).map((index) => ({
      document_id: index.document_id,
      collection: index.collection,
      vector_count: index.chunk_count,
      metadata: metadata.get(`${index.collection}\u0000${index.document_id}`) ?? {},
    }));
  }

  async listFileChunks(fileId: string) {
    return this.vectors.listChunks({ tenant_id: this.tenantId, document_id: fileId });
  }

  async updateChunk(fileId: string, chunkId: string, content: string) {
    const chunk = await this.vectors.getChunk(this.tenantId, chunkId);
    if (!chunk || chunk.document_id !== fileId) throw new KnowledgeBaseError(`切片不存在: ${chunkId}`, 404);
    const [vectorizers, versions] = await Promise.all([
      this.config.listVectorizers(this.tenantId),
      this.vectors.listChunkVersions(this.tenantId, chunkId),
    ]);
    const updatedMetadata = { ...chunk.metadata, manual: true };
    const records = [];
    for (const version of versions) {
      const vectorizer = vectorizers.find((item) => item.model_id === version.model_id);
      if (!vectorizer) continue;
      const [embedding] = await (await this.resolveEmbedder(vectorizer)).embed([content]);
      if (!embedding?.length) throw new KnowledgeBaseError("向量化器返回了无效向量", 500);
      records.push({
        tenant_id: this.tenantId,
        collection: version.collection,
        document_id: fileId,
        model_id: vectorizer.model_id,
        chunk_index: version.chunk_index,
        content,
        metadata: updatedMetadata,
        embedding,
      });
    }
    if (records.length === 0) throw new KnowledgeBaseError("切片没有可用的向量模型，无法重嵌入", 409);
    await this.vectors.upsertChunks(records);
    return { ...chunk, content, metadata: updatedMetadata };
  }

  async migrate(input: GenericVectorRequest): Promise<Record<string, unknown>> {
    const fromKey = stringValue(input.from_key) ?? stringValue(input.fromKey);
    const toKey = stringValue(input.to_key) ?? stringValue(input.toKey);
    if (!fromKey || !toKey) throw new KnowledgeBaseError("缺少 from_key 或 to_key", 400);
    const [source, target] = await Promise.all([
      this.config.getVectorizerByKey(this.tenantId, fromKey),
      this.config.getVectorizerByKey(this.tenantId, toKey),
    ]);
    if (!source || !target) throw new KnowledgeBaseError("源或目标向量化器不存在", 404);
    const chunks = await this.vectors.listChunks({ tenant_id: this.tenantId, model_id: source.model_id });
    await this.embedAndStoreChunks(chunks, target);
    return { from_key: fromKey, to_key: toKey, migrated_chunks: chunks.length };
  }

  async search(input: SearchVectorsRequest): Promise<KnowledgeSearchResponse> {
    const query = input.query.trim();
    if (!query) throw new KnowledgeBaseError("查询内容不能为空", 400);
    const collection = input.collection_name?.trim() || input.collection?.trim() || "documents";
    const mode = input.search_mode ?? input.mode ?? "hybrid";
    if (mode !== "hybrid" && mode !== "vector") throw new KnowledgeBaseError("search_mode 只能是 hybrid 或 vector", 400);
    const vectorizer = await this.activeVectorizer();
    const embedder = await this.resolveEmbedder(vectorizer);
    const [queryVector] = await embedder.embed([query]);
    if (!queryVector) return { results: [], count: 0, collection_name: collection, query, search_mode: mode, rerank: false, rerank_mode: "none" };
    const topK = input.top_k ?? 5;
    const candidateLimit = Math.max(1, Math.min(100, input.rerank_top_k ?? Math.max(topK, 20)));
    const hits = await this.vectors.search({ tenant_id: this.tenantId, collection, model_id: vectorizer.model_id, query_vector: queryVector, top_k: candidateLimit });
    const candidates: VectorSearchResult[] = hits.map((hit) => {
      const keyword = keywordOverlapScore(query, hit.content);
      const hybrid = hybridScore(hit.vector_score, keyword);
      return { id: hit.id, doc_id: hit.document_id, document_id: hit.document_id, collection: hit.collection, text: hit.content, content: hit.content, metadata: hit.metadata, score: mode === "vector" ? hit.vector_score : hybrid, similarity: hit.vector_score, keyword_score: keyword, vector_score: hit.vector_score, hybrid_score: hybrid };
    }).filter((hit) => hit.vector_score > 0 || hit.keyword_score > 0).sort((a, b) => b.score - a.score).slice(0, candidateLimit);
    const rerankers = await this.config.listRerankers(this.tenantId);
    const selectedReranker = input.reranker_key
      ? rerankers.find((item) => item.reranker_key === input.reranker_key) ?? null
      : rerankers.find((item) => item.is_active) ?? null;
    if (input.reranker_key && !selectedReranker) throw new KnowledgeBaseError(`重排序器不存在: ${input.reranker_key}`, 404);
    const reranker = input.rerank !== false && selectedReranker && mode === "hybrid" ? this.rerankerFactory(selectedReranker) : null;
    let results = candidates;
    let rerankMode: KnowledgeSearchResponse["rerank_mode"] = "none";
    if (reranker) {
      try {
        const reranked = await reranker.rerank(query, candidates);
        results = reranked.results;
        rerankMode = reranked.mode;
      } catch {
        results = lexicalRerank(candidates, query).map((result) => ({ ...result, rerank_degraded: true }));
        rerankMode = "degraded";
      }
    }
    results = results.slice(0, input.final_top_k ?? topK);
    return { results, count: results.length, collection_name: collection, query, search_mode: mode, rerank: reranker !== null, rerank_mode: rerankMode };
  }

  async indexExternalFile(input: IndexFileRequest, file: KnowledgeFile, markdown: string): Promise<Record<string, unknown>> {
    const vectorizer = await this.config.getVectorizerByKey(this.tenantId, input.vectorizer_key.trim());
    if (!vectorizer) throw new KnowledgeBaseError(`向量化器不存在: ${input.vectorizer_key}`, 404);
    const chunkSize = positiveInteger(input.chunk_size, 500);
    const overlap = nonNegativeInteger(input.overlap, 50);
    const indexedChunks = await this.indexTextDocument({
      collection: input.collection,
      documentId: file.id,
      markdown,
      metadata: { source: file.original_name, source_file: file.original_name, file_id: file.id, original_filename: file.original_name, mime: file.mime },
      vectorizer,
      chunkSize,
      overlap,
    });
    return { collection: input.collection, file_id: file.id, vectorizer_key: vectorizer.vectorizer_key, indexed_chunks: indexedChunks, message: `成功索引文件，生成 ${indexedChunks} 个分块` };
  }

  async reindexFileContent(file: KnowledgeFile, markdown: string): Promise<number> {
    const indexes = (await this.vectors.listDocumentIndexes(this.tenantId)).filter((index) => index.document_id === file.id);
    const vectorizers = await this.config.listVectorizers(this.tenantId);
    const targets = new Map<string, StoredVectorizer>();
    for (const index of indexes) {
      const vectorizer = vectorizers.find((item) => item.model_id === index.model_id);
      if (vectorizer) targets.set(`${index.collection}\u0000${vectorizer.model_id}`, vectorizer);
    }
    let indexedChunks = 0;
    for (const [key, vectorizer] of targets) {
      const collection = key.split("\u0000", 1)[0] ?? "documents";
      indexedChunks = Math.max(indexedChunks, await this.indexTextDocument({
        collection,
        documentId: file.id,
        markdown,
        metadata: { source: file.original_name, source_file: file.original_name, file_id: file.id, original_filename: file.original_name, mime: file.mime },
        vectorizer,
        chunkSize: 500,
        overlap: 50,
      }));
    }
    return indexedChunks;
  }

  async deleteDocument(collection: string, documentId: string): Promise<Record<string, unknown>> {
    const deleted_chunks = await this.vectors.deleteChunks({ tenant_id: this.tenantId, collection, document_id: documentId });
    return { message: `文档 ${documentId} 已从集合 ${collection} 中删除`, collection, document_id: documentId, deleted_chunks };
  }

  deleteKnowledgeVectors(fileId: string): Promise<number> {
    return this.vectors.deleteChunks({ tenant_id: this.tenantId, document_id: fileId });
  }

  async deleteCollection(collection: string): Promise<Record<string, unknown>> {
    const deleted_chunks = await this.vectors.deleteCollection({ tenant_id: this.tenantId, collection });
    return { message: `集合 ${collection} 已删除`, collection, deleted_chunks };
  }

  async listDocuments(collection: string): Promise<Record<string, unknown>> {
    const documents = await this.vectors.listDocuments({ tenant_id: this.tenantId, collection });
    const info = (await this.listCollections()).find((item) => item.name === collection) ?? {};
    return {
      collection_name: collection,
      total_chunks: documents.reduce((sum, document) => sum + document.chunk_count, 0),
      sample_ids: documents.map((document) => document.document_id).slice(0, 20),
      info,
    };
  }

  async indexDocument(input: GenericVectorRequest, resolved?: { documentId: string; markdown: string; metadata: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const collection = stringValue(input.collection_name) ?? stringValue(input.collection) ?? "documents";
    const documentId = resolved?.documentId ?? stringValue(input.document_id) ?? "";
    const markdown = resolved?.markdown ?? stringValue(input.markdown) ?? stringValue(input.text) ?? "";
    const metadata = resolved?.metadata ?? recordValue(input.metadata);
    if (!documentId || !markdown) throw new KnowledgeBaseError("document_id和 Markdown 内容不能为空", 400);
    const vectorizer = await this.activeVectorizer();
    const indexedChunks = await this.indexTextDocument({
      collection,
      documentId,
      markdown,
      metadata,
      vectorizer,
      chunkSize: positiveInteger(input.chunk_size, 500),
      overlap: nonNegativeInteger(input.overlap, 50),
    });
    return {
      document_id: documentId,
      indexed_chunks: indexedChunks,
      collection_name: collection,
      stats: (await this.listCollections()).find((item) => item.name === collection) ?? {},
      message: `成功索引文档，生成 ${indexedChunks} 个分块`,
    };
  }

  async vectorHealth(): Promise<Record<string, unknown>> {
    const [health, vectorizers, rerankers] = await Promise.all([
      this.vectors.health(this.tenantId),
      this.config.listVectorizers(this.tenantId),
      this.config.listRerankers(this.tenantId),
    ]);
    return {
      ...health,
      vectorizers_count: vectorizers.length,
      rerankers_count: rerankers.length,
      active_vectorizer_key: vectorizers.find((item) => item.is_active)?.vectorizer_key ?? null,
      active_reranker_key: rerankers.find((item) => item.is_active)?.reranker_key ?? null,
    };
  }

  async getModelStats(modelId: number): Promise<{ vector_count: number; storage_size_mb: number; collections: Record<string, number> }> {
    const rows = await this.vectors.countVectorsByModel({ tenant_id: this.tenantId, model_id: modelId });
    const vectorCount = rows.reduce((sum, row) => sum + row.count, 0);
    const dimension = await this.vectors.getDimension({ tenant_id: this.tenantId, model_id: modelId }) ?? 0;
    return { vector_count: vectorCount, storage_size_mb: Math.round((vectorCount * dimension * 4 / 1024 / 1024) * 100) / 100, collections: Object.fromEntries(rows.map((row) => [row.collection, row.count])) };
  }

  async getSyncStatus(collection: string) {
    const totalDocuments = await this.vectors.countChunks({ tenant_id: this.tenantId, collection });
    const result = [];
    for (const vectorizer of await this.config.listVectorizers(this.tenantId)) {
      const synced = await this.vectors.countVectors({ tenant_id: this.tenantId, collection, model_id: vectorizer.model_id });
      result.push({ model_id: vectorizer.model_id, vectorizer_key: vectorizer.vectorizer_key, total_documents: totalDocuments, synced_documents: synced, pending_documents: Math.max(totalDocuments - synced, 0), sync_percentage: totalDocuments ? Math.round((synced / totalDocuments) * 10000) / 100 : 0 });
    }
    return result;
  }

  async syncModel(modelId: number, input: { collection: string; limit?: number | null }): Promise<Record<string, unknown>> {
    const vectorizer = (await this.config.listVectorizers(this.tenantId)).find((item) => item.model_id === modelId);
    if (!vectorizer) throw new KnowledgeBaseError(`模型不存在: ${modelId}`, 404);
    const collection = input.collection || "default";
    const [canonical, indexed] = await Promise.all([
      this.vectors.listChunks({ tenant_id: this.tenantId, collection }),
      this.vectors.listChunks({ tenant_id: this.tenantId, collection, model_id: modelId }),
    ]);
    const indexedKeys = new Set(indexed.map((chunk) => `${chunk.document_id}\u0000${chunk.chunk_index}`));
    let chunks = canonical.filter((chunk) => !indexedKeys.has(`${chunk.document_id}\u0000${chunk.chunk_index}`));
    if (input.limit) chunks = chunks.slice(0, input.limit);
    await this.embedAndStoreChunks(chunks, vectorizer);
    return { model_id: modelId, collection, synced_documents: chunks.length };
  }

  private async activeVectorizer(): Promise<StoredVectorizer> {
    const all = await this.config.listVectorizers(this.tenantId);
    const active = all.find((v) => v.is_active) ?? all[0];
    if (active) return active;
    return this.config.createVectorizer(this.tenantId, { vectorizer_key: "local_hash_embedding", provider_key: "local", provider_type: "local", model_name: "hash-embedding", distance_metric: "cosine" });
  }
  private async resolveEmbedder(vectorizer: StoredVectorizer) {
    const cached = this.embedderCache.get(vectorizer.vectorizer_key);
    if (cached) return cached;
    const provider = vectorizer.provider_key !== "local" ? this.modelAdapter.getProvider(vectorizer.provider_key) : null;
    const embedder = this.embedderFactory(provider, vectorizer.model_name);
    this.embedderCache.set(vectorizer.vectorizer_key, embedder);
    return embedder;
  }
  private async toVectorizerConfig(vectorizer: StoredVectorizer): Promise<VectorizerConfig> {
    const stats = await this.getModelStats(vectorizer.model_id);
    const dimension = await this.vectors.getDimension({ tenant_id: this.tenantId, model_id: vectorizer.model_id });
    return { ...vectorizer, vector_dimension: dimension ?? vectorizer.vector_dimension, provider_available: vectorizer.provider_key === "local" || this.modelAdapter.hasProvider(vectorizer.provider_key), vector_count: stats.vector_count };
  }

  private async indexTextDocument(input: { collection: string; documentId: string; markdown: string; metadata: Record<string, unknown>; vectorizer: StoredVectorizer; chunkSize: number; overlap: number }): Promise<number> {
    if (input.overlap >= input.chunkSize) throw new KnowledgeBaseError("overlap 必须小于 chunk_size", 400);
    const chunks = chunkMarkdown(input.markdown, input.chunkSize, input.overlap);
    if (!chunks.length) {
      await this.vectors.replaceChunks({
        tenant_id: this.tenantId,
        collection: input.collection,
        document_id: input.documentId,
        model_id: input.vectorizer.model_id,
        records: [],
      });
      return 0;
    }
    const embeddings = await (await this.resolveEmbedder(input.vectorizer)).embed(chunks.map((chunk) => chunk.content));
    const dimension = embeddings[0]?.length ?? 0;
    if (dimension <= 0 || embeddings.some((embedding) => embedding.length !== dimension)) throw new KnowledgeBaseError("向量化器返回了无效或不一致的向量维度", 500);
    await this.config.setVectorDimension(this.tenantId, input.vectorizer.vectorizer_key, dimension);
    await this.vectors.replaceChunks({
      tenant_id: this.tenantId,
      collection: input.collection,
      document_id: input.documentId,
      model_id: input.vectorizer.model_id,
      records: chunks.map((chunk, index) => ({ tenant_id: this.tenantId, collection: input.collection, document_id: input.documentId, model_id: input.vectorizer.model_id, chunk_index: index, content: chunk.content, metadata: { ...input.metadata, document_id: input.documentId, chunk_index: index, char_start: chunk.charStart, char_end: chunk.charEnd, heading_path: "" }, embedding: embeddings[index] ?? [] })),
    });
    return chunks.length;
  }

  private async embedAndStoreChunks(chunks: Array<{ collection: string; document_id: string; chunk_index: number; content: string; metadata: Record<string, unknown> }>, vectorizer: StoredVectorizer): Promise<void> {
    if (!chunks.length) return;
    const embeddings = await (await this.resolveEmbedder(vectorizer)).embed(chunks.map((chunk) => chunk.content));
    const dimension = embeddings[0]?.length ?? 0;
    if (dimension <= 0 || embeddings.some((embedding) => embedding.length !== dimension)) throw new KnowledgeBaseError("向量化器返回了无效或不一致的向量维度", 500);
    await this.config.setVectorDimension(this.tenantId, vectorizer.vectorizer_key, dimension);
    await this.vectors.upsertChunks(chunks.map((chunk, index) => ({ tenant_id: this.tenantId, collection: chunk.collection, document_id: chunk.document_id, model_id: vectorizer.model_id, chunk_index: chunk.chunk_index, content: chunk.content, metadata: chunk.metadata, embedding: embeddings[index] ?? [] })));
  }
}

function toRerankerConfig(reranker: StoredReranker): RerankerConfig {
  return {
    reranker_key: reranker.reranker_key, mode: reranker.mode, provider_key: reranker.provider_key,
    provider_type: reranker.provider_type, model_name: reranker.model_name, api_endpoint: reranker.api_endpoint,
    created_at: reranker.created_at, is_active: reranker.is_active, api_key_set: Boolean(reranker.api_key),
  };
}

function normalizeRerankerMode(value: string | undefined): StoredReranker["mode"] {
  const mode = String(value ?? "none").trim().toLowerCase();
  if (["lexical", "bm25", "keyword", "local"].includes(mode)) return "lexical";
  if (["none", "noop"].includes(mode)) return "none";
  return "model";
}

function normalizeRerankerKey(mode: StoredReranker["mode"], providerKey: string, modelName: string): string {
  if (mode === "none") return "noop";
  if (mode === "lexical") return "bm25_local";
  return `${providerKey}_${modelName.replace(/[^\w.-]/g, "_").slice(0, 120)}`;
}

interface MarkdownChunk { content: string; charStart: number; charEnd: number; }
function chunkMarkdown(markdown: string, size: number, overlap: number): MarkdownChunk[] {
  const text = markdown.trim();
  if (!text) return [];
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + size);
    chunks.push({ content: text.slice(start, end), charStart: start, charEnd: end });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
