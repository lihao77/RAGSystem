import type { AsyncKnowledgeFileStore } from "../../../../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../../../../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { KnowledgeApplication, KnowledgeUploadPart } from "../../../../contracts/application/knowledge-application.js";
import type { KnowledgeFile } from "../../../../contracts/vector-store/knowledge-file-store.js";
import { KnowledgeBaseError } from "../../../../contracts/knowledge/knowledge-base.js";
import type { VectorFileStatusResponse } from "../../../../contracts/knowledge/knowledge-base.js";
import type { SaaSKnowledgeVectorApplication } from "./saas-knowledge-vector-application.js";

export class SaaSKnowledgeApplication implements KnowledgeApplication {
  constructor(
    private readonly vector: SaaSKnowledgeVectorApplication,
    private readonly files: AsyncKnowledgeFileStore,
    private readonly markdown: AsyncKnowledgeMarkdownPipeline,
  ) {}
  async upload(parts: KnowledgeUploadPart[]) {
    const files: KnowledgeFile[] = [];
    for (const part of parts) {
      const file = await this.files.addKnowledgeFile({ originalName: part.filename, buffer: part.buffer, mime: part.mime });
      try { await this.markdown.generateMarkdownForFile(file.id); } catch { /* upload remains durable */ }
      files.push(await this.files.getKnowledgeFile(file.id) ?? file);
    }
    return files;
  }
  listFiles() { return this.files.listKnowledgeFiles(); }
  getFile(fileId: string) { return this.files.getKnowledgeFile(fileId); }
  readMarkdown(fileId: string) { return this.markdown.readMarkdownForFile(fileId); }
  async updateMarkdown(fileId: string, content: string) { return this.markdown.updateMarkdown(fileId, content); }
  async listChunks(_fileId: string): Promise<Array<{ id: number; content: string; metadata: Record<string, unknown>; chunk_index: number }>> {
    throw new KnowledgeBaseError("SaaS knowledge chunks operation unavailable", 501);
  }
  async updateChunk() { throw new KnowledgeBaseError("SaaS knowledge chunks operation unavailable", 501); }
  deleteFile(fileId: string) { return this.vector.deleteKnowledgeFile(fileId); }
  async download(fileId: string) {
    const file = await this.files.getKnowledgeFile(fileId);
    if (!file) return null;
    const source = await this.files.getSource(file.id);
    if (!source) return null;
    return { body: source.body, filename: file.original_name, mime: source.contentType ?? file.mime };
  }
  fileStatus() { return this.unavailable<VectorFileStatusResponse>(); }
  indexFile(input: Parameters<SaaSKnowledgeVectorApplication["indexFile"]>[0]) { return this.vector.indexFile(input); }
  listVectorizers() { return this.vector.listVectorizers(); }
  addVectorizer(input: Parameters<SaaSKnowledgeVectorApplication["addVectorizer"]>[0]) { return this.vector.addVectorizer(input); }
  activateVectorizer(key: string) { return this.vector.activateVectorizer(key); }
  listDocsByVectorizer() { return this.unavailable<Array<Record<string, unknown>>>(); }
  deleteVectorizer(key: string) { return this.vector.deleteVectorizer(key); }
  migrate() { return this.unavailable<Record<string, unknown>>(); }
  listRerankers(): never { throw new KnowledgeBaseError("SaaS reranker operation unavailable", 501); }
  addReranker() { throw new KnowledgeBaseError("SaaS reranker operation unavailable", 501); }
  getReranker(_key: string): never { throw new KnowledgeBaseError("SaaS reranker operation unavailable", 501); }
  activateReranker() { throw new KnowledgeBaseError("SaaS reranker operation unavailable", 501); }
  deleteReranker() { throw new KnowledgeBaseError("SaaS reranker operation unavailable", 501); }
  listCollections() { return this.vector.listCollections(); }
  deleteCollection() { return this.unavailable<Record<string, unknown>>(); }
  search(input: Parameters<SaaSKnowledgeVectorApplication["search"]>[0]) { return this.vector.search(input); }
  indexDocument() { return this.unavailable<Record<string, unknown>>(); }
  deleteDocument(collection: string, documentId: string) { return this.vector.deleteDocument(collection, documentId); }
  listDocuments() { return this.unavailable<Record<string, unknown>>(); }
  vectorHealth() { return Promise.resolve({ status: "healthy", collections_count: 0 }); }
  private unavailable<T>(): Promise<T> { return Promise.reject(new KnowledgeBaseError("SaaS knowledge operation unavailable", 501)); }
}
