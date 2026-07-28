import type { KnowledgeApplication, KnowledgeUploadPart } from "../../contracts/knowledge-application.js";
import type { AsyncKnowledgeFileStore } from "../../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import { KnowledgeBaseError } from "../../contracts/knowledge/knowledge-base.js";
import type { KnowledgeApplicationService } from "./knowledge-application-service.js";
import {
  PROVIDER_USAGE_CONTRIBUTOR,
  type ProviderUsage,
} from "@ragsystem/backend-core/contracts/integrations/provider-usage.js";

/** Deployment-neutral knowledge HTTP workflow backed by injected storage ports. */
export class KnowledgeHttpApplication implements KnowledgeApplication {
  constructor(
    private readonly knowledge: KnowledgeApplicationService,
    private readonly files: AsyncKnowledgeFileStore,
    private readonly markdown: AsyncKnowledgeMarkdownPipeline,
  ) {}

  async [PROVIDER_USAGE_CONTRIBUTOR](providerAliases: ReadonlySet<string>): Promise<readonly ProviderUsage[]> {
    const [vectorizers, rerankers] = await Promise.all([
      this.knowledge.listVectorizers(),
      this.knowledge.listRerankers(),
    ]);
    return [
      ...vectorizers
        .filter((item) => providerAliases.has(normalizeProviderRef(item.provider_key)))
        .map((item) => ({
          kind: "vectorizer",
          key: item.vectorizer_key,
          label: item.vectorizer_key,
          detail: item.model_name,
        })),
      ...rerankers
        .filter((item) => item.mode === "model" && providerAliases.has(normalizeProviderRef(item.provider_key)))
        .map((item) => ({
          kind: "reranker",
          key: item.reranker_key,
          label: item.reranker_key,
          detail: item.model_name,
        })),
    ];
  }

  async upload(parts: KnowledgeUploadPart[]) {
    const uploaded = [];
    for (const part of parts) {
      const file = await this.files.addKnowledgeFile({ originalName: part.filename, buffer: part.buffer, mime: part.mime });
      try {
        await this.markdown.generateMarkdownForFile(file.id);
      } catch {
        // Source upload is durable even when preview extraction is unavailable.
      }
      uploaded.push(await this.files.getKnowledgeFile(file.id) ?? file);
    }
    return uploaded;
  }

  listFiles() { return this.files.listKnowledgeFiles(); }
  getFile(fileId: string) { return this.files.getKnowledgeFile(fileId); }
  readMarkdown(fileId: string) { return this.markdown.readMarkdownForFile(fileId); }

  async updateMarkdown(fileId: string, content: string) {
    const file = await this.requireFile(fileId);
    const stored = await this.markdown.updateMarkdown(fileId, content);
    const indexed_chunks = await this.knowledge.reindexFileContent(file, content);
    return { ...stored, indexed_chunks };
  }

  async listChunks(fileId: string) {
    await this.requireFile(fileId);
    return this.knowledge.listFileChunks(fileId);
  }

  updateChunk(fileId: string, chunkId: string | number, content: string) {
    return this.knowledge.updateChunk(fileId, String(chunkId), content);
  }

  async deleteFile(fileId: string) {
    const file = await this.files.getKnowledgeFile(fileId);
    if (!file) return null;
    const deleted_chunks = await this.knowledge.deleteKnowledgeVectors(fileId);
    await this.files.deleteKnowledgeFile(fileId);
    return { deleted_chunks };
  }

  async download(fileId: string) {
    const file = await this.files.getKnowledgeFile(fileId);
    if (!file) return null;
    const source = await this.files.getSource(file.id);
    if (!source) return null;
    return { body: source.body, filename: file.original_name, mime: source.contentType ?? file.mime };
  }

  async fileStatus() { return this.knowledge.fileStatus(await this.files.listKnowledgeFiles()); }

  async indexFile(input: Parameters<KnowledgeApplicationService["indexExternalFile"]>[0]) {
    const file = await this.requireFile(input.file_id.trim());
    return this.knowledge.indexExternalFile(input, file, (await this.resolveMarkdown(file.id)).markdown);
  }

  listVectorizers() { return this.knowledge.listVectorizers(); }
  addVectorizer(input: Parameters<KnowledgeApplicationService["addVectorizer"]>[0]) { return this.knowledge.addVectorizer(input); }
  activateVectorizer(key: string) { return this.knowledge.activateVectorizer(key); }
  listDocsByVectorizer(key: string) { return this.knowledge.listDocsByVectorizer(key); }
  deleteVectorizer(key: string) { return this.knowledge.deleteVectorizer(key); }
  migrate(input: Parameters<KnowledgeApplicationService["migrate"]>[0]) { return this.knowledge.migrate(input); }
  listRerankers() { return this.knowledge.listRerankers(); }
  addReranker(input: Parameters<KnowledgeApplicationService["addReranker"]>[0]) { return this.knowledge.addReranker(input); }
  getReranker(key: string) { return this.knowledge.getReranker(key); }
  activateReranker(key: string) { return this.knowledge.activateReranker(key); }
  deleteReranker(key: string) { return this.knowledge.deleteReranker(key); }
  listCollections() { return this.knowledge.listCollections(); }
  deleteCollection(collection: string) { return this.knowledge.deleteCollection(collection); }
  search(input: Parameters<KnowledgeApplicationService["search"]>[0]) { return this.knowledge.search(input); }

  async indexDocument(input: Parameters<KnowledgeApplicationService["indexDocument"]>[0]) {
    const fileId = typeof input.file_id === "string" ? input.file_id.trim() : "";
    if (!fileId) return this.knowledge.indexDocument(input);
    const file = await this.requireFile(fileId);
    const metadata = input.metadata !== null && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata as Record<string, unknown>
      : {};
    return this.knowledge.indexDocument(input, {
      documentId: typeof input.document_id === "string" && input.document_id.trim() ? input.document_id.trim() : file.id,
      markdown: (await this.resolveMarkdown(file.id)).markdown,
      metadata: {
        ...metadata,
        source: metadata.source ?? file.original_name,
        source_file: metadata.source_file ?? file.original_name,
        file_id: file.id,
        original_filename: file.original_name,
        mime: file.mime,
      },
    });
  }

  deleteDocument(collection: string, documentId: string) { return this.knowledge.deleteDocument(collection, documentId); }
  listDocuments(collection: string) { return this.knowledge.listDocuments(collection); }
  vectorHealth() { return this.knowledge.vectorHealth(); }
  getModelStats(modelId: number) { return this.knowledge.getModelStats(modelId); }
  getSyncStatus(collection: string) { return this.knowledge.getSyncStatus(collection); }
  syncModel(modelId: number, input: { collection: string; limit?: number | null }) { return this.knowledge.syncModel(modelId, input); }

  private async requireFile(fileId: string) {
    const file = await this.files.getKnowledgeFile(fileId);
    if (!file) throw new KnowledgeBaseError(`文件不存在: ${fileId}`, 404);
    return file;
  }

  private async resolveMarkdown(fileId: string) {
    try {
      return await this.markdown.readMarkdownForFile(fileId);
    } catch {
      await this.markdown.generateMarkdownForFile(fileId);
      return this.markdown.readMarkdownForFile(fileId);
    }
  }
}

function normalizeProviderRef(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}
