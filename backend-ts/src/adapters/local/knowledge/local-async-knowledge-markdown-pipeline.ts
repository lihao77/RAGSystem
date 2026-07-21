import type { AsyncKnowledgeMarkdownPipeline } from "../../../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { IKnowledgeFileStore } from "../../../contracts/vector-store/index.js";
import type { KnowledgeBaseService } from "../../../services/knowledge/knowledge-base-service.js";

/** Async Markdown facade that reuses the Local document extraction pipeline. */
export class LocalAsyncKnowledgeMarkdownPipeline implements AsyncKnowledgeMarkdownPipeline {
  constructor(
    private readonly store: IKnowledgeFileStore,
    private readonly knowledge: Pick<KnowledgeBaseService, "generateMarkdownForFile">,
  ) {}

  async generateMarkdownForFile(fileId: string): Promise<{ md_blob_hash: string }> {
    await this.knowledge.generateMarkdownForFile(fileId);
    const file = this.store.getKnowledgeFile(fileId);
    if (!file?.md_blob_hash) throw new Error(`Markdown 生成后未持久化: ${fileId}`);
    return { md_blob_hash: file.md_blob_hash };
  }

  async readMarkdownForFile(fileId: string): Promise<{ markdown: string; md_blob_hash: string }> {
    const file = this.store.getKnowledgeFile(fileId);
    if (!file) throw new Error(`知识库文件不存在: ${fileId}`);
    if (!file.md_blob_hash) throw new Error(`Markdown 尚未生成: ${fileId}`);
    return {
      markdown: this.store.readKnowledgeMarkdown(file.md_blob_hash),
      md_blob_hash: file.md_blob_hash,
    };
  }

  async updateMarkdown(fileId: string, content: string): Promise<{ md_blob_hash: string }> {
    if (!this.store.getKnowledgeFile(fileId)) throw new Error(`知识库文件不存在: ${fileId}`);
    return this.store.putKnowledgeMarkdown(fileId, content);
  }
}
