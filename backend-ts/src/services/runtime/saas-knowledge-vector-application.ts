import type { IndexFileRequest, SearchVectorsRequest } from "../../contracts/knowledge-base.js";
import type { AsyncKnowledgeFileStore } from "../../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { AsyncKnowledgeVectorStore } from "../../contracts/knowledge/async-vector-store.js";
import { KnowledgeBaseError } from "../../contracts/knowledge-base.js";
import type { KnowledgeBaseService } from "../knowledge/knowledge-base-service.js";

/** Tenant-bound bridge from HTTP knowledge workflows to PostgreSQL/S3 data planes. */
export class SaaSKnowledgeVectorApplication {
  private readonly knowledge: KnowledgeBaseService;
  private readonly tenantId: string;

  constructor(
    tenantId: string,
    baseKnowledge: KnowledgeBaseService,
    private readonly files: AsyncKnowledgeFileStore,
    private readonly markdown: AsyncKnowledgeMarkdownPipeline,
    private readonly vectors: AsyncKnowledgeVectorStore,
  ) {
    this.tenantId = tenantId;
    this.knowledge = baseKnowledge.withAsyncVectorStore(vectors, tenantId);
  }

  async indexFile(input: IndexFileRequest): Promise<Record<string, unknown>> {
    const file = await this.files.getKnowledgeFile(input.file_id.trim());
    if (!file) throw new KnowledgeBaseError(`文件不存在: ${input.file_id}`, 404);
    const source = await this.markdown.readMarkdownForFile(file.id);
    return this.knowledge.indexExternalFile(input, file, source.markdown);
  }

  search(input: SearchVectorsRequest): Promise<Record<string, unknown>> {
    return this.knowledge.search(input);
  }

  deleteDocument(collection: string, documentId: string): Promise<Record<string, unknown>> {
    return this.knowledge.deleteDocument(collection, documentId);
  }

  async deleteKnowledgeFile(fileId: string): Promise<{ deleted_chunks: number } | null> {
    const file = await this.files.getKnowledgeFile(fileId);
    if (!file) return null;
    const deleted_chunks = await this.vectors.deleteChunks({ tenant_id: this.tenantId, document_id: fileId });
    await this.files.deleteKnowledgeFile(fileId);
    return { deleted_chunks };
  }
}
