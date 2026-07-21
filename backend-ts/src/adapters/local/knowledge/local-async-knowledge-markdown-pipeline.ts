import type { AsyncKnowledgeFileStore } from "../../../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../../../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { DocumentExtractor } from "../../../contracts/knowledge/document-extractor.js";

/** Local Markdown pipeline: extract from on-disk source via DocumentExtractor, persist via AsyncKnowledgeFileStore. */
export class LocalAsyncKnowledgeMarkdownPipeline implements AsyncKnowledgeMarkdownPipeline {
  constructor(
    private readonly store: AsyncKnowledgeFileStore,
    private readonly extractor: DocumentExtractor,
  ) {}

  async generateMarkdownForFile(fileId: string): Promise<{ md_blob_hash: string }> {
    const file = await this.store.getKnowledgeFile(fileId);
    if (!file) throw new Error(`知识库文件不存在: ${fileId}`);
    const extracted = await this.extractor.extract({
      file_path: file.stored_path,
      file_name: file.original_name,
      mime: file.mime,
    });
    return this.store.putKnowledgeMarkdown(file.id, extracted.markdown);
  }

  async readMarkdownForFile(fileId: string): Promise<{ markdown: string; md_blob_hash: string }> {
    const file = await this.store.getKnowledgeFile(fileId);
    if (!file) throw new Error(`知识库文件不存在: ${fileId}`);
    if (!file.md_blob_hash) throw new Error(`Markdown 尚未生成: ${fileId}`);
    return {
      markdown: await this.store.readKnowledgeMarkdown(file.md_blob_hash),
      md_blob_hash: file.md_blob_hash,
    };
  }

  async updateMarkdown(fileId: string, content: string): Promise<{ md_blob_hash: string }> {
    const file = await this.store.getKnowledgeFile(fileId);
    if (!file) throw new Error(`知识库文件不存在: ${fileId}`);
    return this.store.putKnowledgeMarkdown(file.id, content);
  }
}
