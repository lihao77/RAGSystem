import type { IndexFileRequest, SearchVectorsRequest, VectorizerConfig, VectorizerCreate } from "../../../../contracts/knowledge/knowledge-base.js";
import type { AsyncKnowledgeFileStore } from "../../../../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../../../../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { AsyncKnowledgeVectorStore } from "../../../../contracts/knowledge/async-vector-store.js";
import { KnowledgeBaseError } from "../../../../contracts/knowledge/knowledge-base.js";

interface SaaSKnowledgeOperations {
  indexExternalFile(input: IndexFileRequest, file: Awaited<ReturnType<AsyncKnowledgeFileStore["getKnowledgeFile"]>> & {}, markdown: string): Promise<unknown>;
  search(input: SearchVectorsRequest): Promise<unknown>;
  deleteDocument(collection: string, documentId: string): Promise<unknown>;
  listVectorizers?(): Promise<VectorizerConfig[]>;
  addVectorizer?(input: VectorizerCreate): Promise<Pick<VectorizerConfig, "vectorizer_key" | "vector_dimension" | "model_id">>;
  activateVectorizer?(key: string): Promise<{ active_vectorizer_key: string }>;
  deleteVectorizer?(key: string): Promise<{ deleted_vectorizer_key: string }>;
  listCollections?(): Promise<unknown>;
}

/** Tenant-bound bridge from HTTP knowledge workflows to PostgreSQL/S3 data planes. */
export class SaaSKnowledgeVectorApplication {
  private readonly knowledge: SaaSKnowledgeOperations;
  constructor(
    private readonly tenantId: string,
    knowledge: SaaSKnowledgeOperations | { withAsyncVectorStore: (vectors: AsyncKnowledgeVectorStore, tenantId: string) => SaaSKnowledgeOperations },
    private readonly files: AsyncKnowledgeFileStore,
    private readonly markdown: AsyncKnowledgeMarkdownPipeline,
    private readonly vectors: AsyncKnowledgeVectorStore,
  ) {
    this.knowledge = "withAsyncVectorStore" in knowledge ? knowledge.withAsyncVectorStore(vectors, tenantId) : knowledge;
  }

  async indexFile(input: IndexFileRequest): Promise<Record<string, unknown>> {
    const file = await this.files.getKnowledgeFile(input.file_id.trim());
    if (!file) throw new KnowledgeBaseError(`文件不存在: ${input.file_id}`, 404);
    const source = await this.markdown.readMarkdownForFile(file.id);
    return await this.knowledge.indexExternalFile(input, file, source.markdown) as Record<string, unknown>;
  }

  search(input: SearchVectorsRequest): Promise<Record<string, unknown>> {
    return this.knowledge.search(input) as Promise<Record<string, unknown>>;
  }

  deleteDocument(collection: string, documentId: string): Promise<Record<string, unknown>> {
    return this.knowledge.deleteDocument(collection, documentId) as Promise<Record<string, unknown>>;
  }

  async listVectorizers(): Promise<VectorizerConfig[]> { return this.require("listVectorizers")(); }
  async addVectorizer(input: VectorizerCreate): Promise<Pick<VectorizerConfig, "vectorizer_key" | "vector_dimension" | "model_id">> { return this.require("addVectorizer")(input); }
  async activateVectorizer(key: string): Promise<{ active_vectorizer_key: string }> { return this.require("activateVectorizer")(key); }
  async deleteVectorizer(key: string): Promise<{ deleted_vectorizer_key: string }> { return this.require("deleteVectorizer")(key); }
  async listCollections(): Promise<unknown> { return this.require("listCollections")(); }

  async deleteKnowledgeFile(fileId: string): Promise<{ deleted_chunks: number } | null> {
    const file = await this.files.getKnowledgeFile(fileId);
    if (!file) return null;
    const deleted_chunks = await this.vectors.deleteChunks({ tenant_id: this.tenantId, document_id: fileId });
    await this.files.deleteKnowledgeFile(fileId);
    return { deleted_chunks };
  }

  private require<K extends keyof SaaSKnowledgeOperations>(method: K): NonNullable<SaaSKnowledgeOperations[K]> {
    const candidate = this.knowledge[method];
    if (typeof candidate !== "function") throw new KnowledgeBaseError(`SaaS knowledge operation unavailable: ${String(method)}`, 501);
    return candidate.bind(this.knowledge) as NonNullable<SaaSKnowledgeOperations[K]>;
  }
}
