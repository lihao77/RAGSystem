import { createHash, randomUUID } from "node:crypto";

import type { KnowledgeFile } from "@ragsystem/backend-core/contracts/vector-store/knowledge-file-store.js";
import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";
import type {
  AddKnowledgeFileMetadataInput,
  KnowledgeFileMetadata,
  KnowledgeFileMetadataRepository,
} from "@ragsystem/backend-core/contracts/knowledge/knowledge-file-repository.js";
import type { AsyncKnowledgeFileStore } from "@ragsystem/backend-core/contracts/knowledge/async-knowledge-file-store.js";

/**
 * SaaS knowledge-file persistence.
 *
 * PostgreSQL stores only tenant-scoped metadata. Bytes are addressed by stable
 * object keys, never by container-local filesystem paths. The `stored_path`
 * field exposed by the legacy file DTO is therefore the source object's key.
 */
export class SaaSKnowledgeFileStorage implements AsyncKnowledgeFileStore {
  constructor(
    private readonly tenantId: string,
    private readonly metadata: KnowledgeFileMetadataRepository,
    private readonly objects: ObjectStorage,
  ) {
    if (!tenantId.trim()) throw new Error("SaaS knowledge file storage requires a tenant id");
  }

  async listKnowledgeFiles(): Promise<KnowledgeFile[]> {
    const rows = await this.metadata.list(this.tenantId);
    return rows.map(toKnowledgeFile);
  }

  async getKnowledgeFile(fileId: string): Promise<KnowledgeFile | null> {
    const row = await this.metadata.get(this.tenantId, fileId);
    return row ? toKnowledgeFile(row) : null;
  }

  async addKnowledgeFile(input: {
    originalName: string;
    buffer: Buffer;
    mime: string;
  }): Promise<KnowledgeFile> {
    const id = randomUUID();
    const safeName = sanitizeName(input.originalName);
    const storedName = `${id}_${safeName}`;
    const key = this.sourceKey(id, storedName);
    await this.objects.put(key, input.buffer, input.mime);
    const rowInput: AddKnowledgeFileMetadataInput = {
      tenant_id: this.tenantId,
      id,
      original_name: input.originalName,
      stored_name: storedName,
      stored_path: key,
      size: input.buffer.byteLength,
      mime: input.mime,
    };
    try {
      return toKnowledgeFile(await this.metadata.create(rowInput));
    } catch (error) {
      await this.objects.delete(key);
      throw error;
    }
  }

  async deleteKnowledgeFile(fileId: string): Promise<KnowledgeFile | null> {
    const row = await this.metadata.get(this.tenantId, fileId);
    if (!row) return null;
    await this.metadata.delete(this.tenantId, fileId);
    await this.objects.delete(row.stored_path);
    if (row.md_blob_hash) await this.objects.delete(this.markdownKey(row.md_blob_hash));
    return toKnowledgeFile(row);
  }

  async putKnowledgeMarkdown(fileId: string, markdown: string): Promise<{ md_blob_hash: string }> {
    const file = await this.metadata.get(this.tenantId, fileId);
    if (!file) throw new Error(`知识库文件不存在: ${fileId}`);
    const hash = createHash("sha256").update(markdown, "utf8").digest("hex");
    await this.objects.put(this.markdownKey(hash), Buffer.from(markdown, "utf8"), "text/markdown; charset=utf-8");
    await this.metadata.setMarkdownHash(this.tenantId, fileId, hash);
    return { md_blob_hash: hash };
  }

  async readKnowledgeMarkdown(mdBlobHash: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(mdBlobHash)) throw new Error("无效的 Markdown blob hash");
    const result = await this.objects.get(this.markdownKey(mdBlobHash));
    if (!result) throw new Error("Markdown blob 不存在");
    return Buffer.from(result.body).toString("utf8");
  }

  async getSource(fileId: string): Promise<{ body: Uint8Array; contentType: string | null } | null> {
    const file = await this.metadata.get(this.tenantId, fileId);
    if (!file) return null;
    const result = await this.objects.get(file.stored_path);
    return result ? { body: result.body, contentType: result.metadata.contentType ?? file.mime } : null;
  }

  private sourceKey(fileId: string, storedName: string): string {
    return `tenants/${encodeURIComponent(this.tenantId)}/knowledge/${fileId}/${storedName}`;
  }

  private markdownKey(hash: string): string {
    return `tenants/${encodeURIComponent(this.tenantId)}/knowledge-markdown/${hash}`;
  }
}

function toKnowledgeFile(row: KnowledgeFileMetadata): KnowledgeFile {
  return {
    id: row.id,
    original_name: row.original_name,
    stored_name: row.stored_name,
    stored_path: row.stored_path,
    size: row.size,
    mime: row.mime,
    uploaded_at: row.uploaded_at,
    md_blob_hash: row.md_blob_hash,
  };
}

function sanitizeName(value: string): string {
  const name = value.trim().replace(/[\\/]+/g, "_").replace(/[^a-zA-Z0-9._-]/g, "_");
  return name.slice(0, 180) || "upload.bin";
}
