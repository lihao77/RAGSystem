import type { AsyncKnowledgeConfigStore } from "../../../../contracts/knowledge/async-knowledge-config.js";
import type { AsyncKnowledgeVectorStore } from "../../../../contracts/knowledge/async-vector-store.js";
import type { IndexFileRequest, SearchVectorsRequest, VectorizerConfig, VectorizerCreate, VectorSearchResult } from "../../../../contracts/knowledge/knowledge-base.js";
import type { KnowledgeCollectionSummary, KnowledgeQueryPort, KnowledgeSearchResponse } from "../../../../contracts/knowledge/query-port.js";
import type { KnowledgeFile } from "../../../../contracts/vector-store/knowledge-file-store.js";
import type { StoredVectorizer } from "../../../../contracts/vector-store/knowledge-config.js";
import type { IEmbedder } from "../../../../contracts/vector-store/embedder.js";
import type { ModelProviderConfig } from "../../../../contracts/integrations/model-adapter.js";
import type { ModelAdapterService } from "../../../../services/integrations/model-adapter-service.js";
import { createEmbedder } from "../../../../services/integrations/embedder-registry.js";
import { hybridScore, keywordOverlapScore } from "../../../../services/vector-store/scoring.js";
import { KnowledgeBaseError } from "../../../../contracts/knowledge/knowledge-base.js";

/** SaaS knowledge orchestration. All config and vectors are tenant-scoped PostgreSQL data. */
export class SaaSKnowledgeService implements KnowledgeQueryPort {
  private readonly embedderCache = new Map<string, IEmbedder>();
  constructor(
    private readonly tenantId: string,
    private readonly modelAdapter: ModelAdapterService,
    private readonly config: AsyncKnowledgeConfigStore,
    private readonly vectors: AsyncKnowledgeVectorStore,
    private readonly embedderFactory: KnowledgeBaseEmbedderFactory = createEmbedder,
  ) {}

  async listCollections(): Promise<KnowledgeCollectionSummary[]> {
    return (await this.vectors.listCollections(this.tenantId)).map((row) => ({
      name: row.name, document_count: row.document_count, chunk_count: row.chunk_count, total_chunks: row.total_chunks,
      metadata: { document_count: row.document_count },
    }));
  }

  async listVectorizers(): Promise<VectorizerConfig[]> {
    return (await this.config.listVectorizers(this.tenantId)).map((vectorizer) => this.toVectorizerConfig(vectorizer));
  }

  async addVectorizer(input: VectorizerCreate): Promise<Pick<VectorizerConfig, "vectorizer_key" | "vector_dimension" | "model_id">> {
    const providerKey = input.provider_key.trim();
    if (providerKey !== "local" && !this.modelAdapter.hasProvider(providerKey)) throw new KnowledgeBaseError(`向量化器引用的 Provider 不存在: ${providerKey}`, 400);
    const modelName = input.model_name.trim();
    const key = input.vectorizer_key?.trim() || `${providerKey}_${modelName}`.replace(/[^a-zA-Z0-9_-]+/g, "_").toLowerCase();
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
    const hits = await this.vectors.search({ tenant_id: this.tenantId, collection, model_id: vectorizer.model_id, query_vector: queryVector, top_k: Math.max(1, Math.min(100, input.rerank_top_k ?? input.top_k ?? 5)) });
    const results: VectorSearchResult[] = hits.map((hit) => {
      const keyword = keywordOverlapScore(query, hit.content);
      const hybrid = hybridScore(hit.vector_score, keyword);
      return { id: hit.id, doc_id: hit.document_id, document_id: hit.document_id, collection: hit.collection, text: hit.content, content: hit.content, metadata: hit.metadata, score: mode === "vector" ? hit.vector_score : hybrid, similarity: hit.vector_score, keyword_score: keyword, vector_score: hit.vector_score, hybrid_score: hybrid };
    }).filter((hit) => hit.vector_score > 0 || hit.keyword_score > 0).sort((a, b) => b.score - a.score).slice(0, input.final_top_k ?? input.top_k ?? 5);
    return { results, count: results.length, collection_name: collection, query, search_mode: mode, rerank: false, rerank_mode: "none" };
  }

  async indexExternalFile(input: IndexFileRequest, file: KnowledgeFile, markdown: string): Promise<Record<string, unknown>> {
    const vectorizer = await this.config.getVectorizerByKey(this.tenantId, input.vectorizer_key.trim());
    if (!vectorizer) throw new KnowledgeBaseError(`向量化器不存在: ${input.vectorizer_key}`, 404);
    const chunkSize = positiveInteger(input.chunk_size, 500);
    const overlap = nonNegativeInteger(input.overlap, 50);
    if (overlap >= chunkSize) throw new KnowledgeBaseError("overlap 必须小于 chunk_size", 400);
    const chunks = chunkMarkdown(markdown, chunkSize, overlap);
    await this.vectors.deleteChunks({ tenant_id: this.tenantId, collection: input.collection, document_id: file.id, model_id: vectorizer.model_id });
    if (chunks.length) {
      const embedder = await this.resolveEmbedder(vectorizer);
      const embeddings = await embedder.embed(chunks.map((chunk) => chunk.content));
      const dimension = embeddings[0]?.length ?? 0;
      if (dimension <= 0 || embeddings.some((embedding) => embedding.length !== dimension)) throw new KnowledgeBaseError("向量化器返回了无效或不一致的向量维度", 500);
      await this.config.setVectorDimension(this.tenantId, vectorizer.vectorizer_key, dimension);
      await this.vectors.upsertChunks(chunks.map((chunk, index) => ({ tenant_id: this.tenantId, collection: input.collection, document_id: file.id, model_id: vectorizer.model_id, chunk_index: index, content: chunk.content, metadata: { source: file.original_name, source_file: file.original_name, file_id: file.id, original_filename: file.original_name, mime: file.mime, chunk_index: index, char_start: chunk.charStart, char_end: chunk.charEnd }, embedding: embeddings[index] ?? [] })));
    }
    return { collection: input.collection, file_id: file.id, vectorizer_key: vectorizer.vectorizer_key, indexed_chunks: chunks.length, message: `成功索引文件，生成 ${chunks.length} 个分块` };
  }

  async deleteDocument(collection: string, documentId: string): Promise<Record<string, unknown>> {
    const deleted_chunks = await this.vectors.deleteChunks({ tenant_id: this.tenantId, collection, document_id: documentId });
    return { collection, document_id: documentId, deleted_chunks };
  }

  private async activeVectorizer(): Promise<StoredVectorizer> {
    const all = await this.config.listVectorizers(this.tenantId);
    const active = all.find((v) => v.is_active) ?? all[0];
    if (active) return active;
    return this.config.createVectorizer(this.tenantId, { vectorizer_key: "local_hash_embedding", provider_key: "local", provider_type: null, model_name: "hash-64", distance_metric: "cosine" });
  }
  private async resolveEmbedder(vectorizer: StoredVectorizer) {
    const cached = this.embedderCache.get(vectorizer.vectorizer_key);
    if (cached) return cached;
    const provider = vectorizer.provider_key !== "local" ? this.modelAdapter.getProvider(vectorizer.provider_key) : null;
    const embedder = this.embedderFactory(provider, vectorizer.model_name);
    this.embedderCache.set(vectorizer.vectorizer_key, embedder);
    return embedder;
  }
  private toVectorizerConfig(vectorizer: StoredVectorizer): VectorizerConfig {
    return { ...vectorizer, provider_available: vectorizer.provider_key === "local" || this.modelAdapter.hasProvider(vectorizer.provider_key), vector_count: 0 };
  }
}

type KnowledgeBaseEmbedderFactory = (provider: ModelProviderConfig | null | undefined, modelName: string) => IEmbedder;

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
