import fs from "node:fs/promises";
import path from "node:path";
import type { KnowledgeApplication, KnowledgeUploadPart } from "../../../../contracts/application/knowledge-application.js";
import type { KnowledgeFile } from "../../../../contracts/vector-store/knowledge-file-store.js";
import type { KnowledgeBaseService } from "../../../../services/knowledge/knowledge-base-service.js";

export class LocalKnowledgeApplication implements KnowledgeApplication {
  constructor(private readonly knowledge: KnowledgeBaseService) {}

  async upload(parts: KnowledgeUploadPart[]): Promise<KnowledgeFile[]> {
    const files: KnowledgeFile[] = [];
    for (const part of parts) {
      const file = this.knowledge.knowledgeFileStore.addKnowledgeFile({ originalName: part.filename, buffer: part.buffer, mime: part.mime });
      try { await this.knowledge.generateMarkdownForFile(file.id); } catch { /* preview generation is best effort */ }
      files.push(this.knowledge.knowledgeFileStore.getKnowledgeFile(file.id) ?? file);
    }
    return files;
  }
  async listFiles() { return this.knowledge.knowledgeFileStore.listKnowledgeFiles(); }
  async getFile(fileId: string) { return this.knowledge.knowledgeFileStore.getKnowledgeFile(fileId); }
  async readMarkdown(fileId: string) {
    const file = this.knowledge.knowledgeFileStore.getKnowledgeFile(fileId);
    if (!file) throw new Error(`文件不存在: ${fileId}`);
    if (!file.md_blob_hash) throw new Error("文件尚未生成 Markdown，请先完成索引");
    return { markdown: this.knowledge.knowledgeFileStore.readKnowledgeMarkdown(file.md_blob_hash), md_blob_hash: file.md_blob_hash };
  }
  updateMarkdown(fileId: string, content: string) { return this.knowledge.updateMarkdown(fileId, content); }
  listChunks(fileId: string) { return this.knowledge.listFileChunks(fileId); }
  updateChunk(fileId: string, chunkId: number, content: string) { return this.knowledge.updateChunk(fileId, chunkId, content); }
  deleteFile(fileId: string) { return this.knowledge.deleteKnowledgeFileWithVectors(fileId); }
  async download(fileId: string) {
    const file = this.knowledge.knowledgeFileStore.getKnowledgeFile(fileId);
    if (!file) return null;
    const storedPath = path.resolve(file.stored_path);
    const root = path.resolve(this.knowledge.knowledgeFileStore.getKnowledgeUploadsRoot());
    const relative = path.relative(root, storedPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    try {
      return { body: await fs.readFile(storedPath), filename: file.original_name, mime: file.mime };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  fileStatus() { return this.knowledge.fileStatus(); }
  indexFile(input: Parameters<KnowledgeBaseService["indexFile"]>[0]) { return this.knowledge.indexFile(input); }
  listVectorizers() { return this.knowledge.listVectorizers(); }
  addVectorizer(input: Parameters<KnowledgeBaseService["addVectorizer"]>[0]) { return this.knowledge.addVectorizer(input); }
  deleteVectorizer(key: string) { return this.knowledge.deleteVectorizer(key); }
  activateVectorizer(key: string) { return this.knowledge.activateVectorizer(key); }
  listDocsByVectorizer(key: string) { return this.knowledge.listDocsByVectorizer(key); }
  migrate(input: Parameters<KnowledgeBaseService["migrate"]>[0]) { return this.knowledge.migrate(input); }
  listRerankers() { return this.knowledge.listRerankers(); }
  addReranker(input: Parameters<KnowledgeBaseService["addReranker"]>[0]) { return this.knowledge.addReranker(input); }
  getReranker(key: string) { return this.knowledge.getReranker(key); }
  activateReranker(key: string) { return this.knowledge.activateReranker(key); }
  deleteReranker(key: string) { return this.knowledge.deleteReranker(key); }
  listCollections() { return this.knowledge.listCollections(); }
  deleteCollection(name: string) { return this.knowledge.deleteCollection(name); }
  search(input: Parameters<KnowledgeBaseService["search"]>[0]) { return this.knowledge.search(input); }
  indexDocument(input: Parameters<KnowledgeBaseService["indexDocument"]>[0]) { return this.knowledge.indexDocument(input); }
  deleteDocument(collection: string, documentId: string) { return this.knowledge.deleteDocument(collection, documentId); }
  listDocuments(collection: string) { return this.knowledge.listDocuments(collection); }
  vectorHealth() { return this.knowledge.vectorHealth(); }
}
