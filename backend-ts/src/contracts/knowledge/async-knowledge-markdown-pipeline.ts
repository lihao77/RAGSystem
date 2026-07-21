import type { AsyncKnowledgeFileStore } from "./async-knowledge-file-store.js";

/** Tenant-bound application port for Markdown generation and editing. */
export interface AsyncKnowledgeMarkdownPipeline {
  generateMarkdownForFile(fileId: string): Promise<{ md_blob_hash: string }>;
  readMarkdownForFile(fileId: string): Promise<{ markdown: string; md_blob_hash: string }>;
  updateMarkdown(fileId: string, content: string): Promise<{ md_blob_hash: string }>;
}

export type AsyncKnowledgeMarkdownExtractor = (input: {
  body: Uint8Array;
  fileName: string;
  mime: string;
}) => Promise<string> | string;

/** Object-backed pipeline; callers may inject a PDF/DOCX-capable extractor. */
export class TenantKnowledgeMarkdownPipeline implements AsyncKnowledgeMarkdownPipeline {
  constructor(
    private readonly store: AsyncKnowledgeFileStore,
    private readonly extract: AsyncKnowledgeMarkdownExtractor = ({ body }) => Buffer.from(body).toString("utf8"),
  ) {}

  async generateMarkdownForFile(fileId: string): Promise<{ md_blob_hash: string }> {
    const file = await this.store.getKnowledgeFile(fileId);
    if (!file) throw new Error(`知识库文件不存在: ${fileId}`);
    const source = await this.store.getSource(file.id);
    if (!source) throw new Error(`知识库文件内容不存在: ${fileId}`);
    const markdown = await this.extract({ body: source.body, fileName: file.original_name, mime: file.mime });
    return this.store.putKnowledgeMarkdown(file.id, markdown);
  }

  async readMarkdownForFile(fileId: string): Promise<{ markdown: string; md_blob_hash: string }> {
    const file = await this.store.getKnowledgeFile(fileId);
    if (!file) throw new Error(`知识库文件不存在: ${fileId}`);
    if (!file.md_blob_hash) throw new Error(`Markdown 尚未生成: ${fileId}`);
    return { markdown: await this.store.readKnowledgeMarkdown(file.md_blob_hash), md_blob_hash: file.md_blob_hash };
  }

  async updateMarkdown(fileId: string, content: string): Promise<{ md_blob_hash: string }> {
    const file = await this.store.getKnowledgeFile(fileId);
    if (!file) throw new Error(`知识库文件不存在: ${fileId}`);
    return this.store.putKnowledgeMarkdown(file.id, content);
  }
}
