import { describe, expect, it } from "vitest";
import { SaaSKnowledgeFileStorage } from "../../src/adapters/saas/object-storage/knowledge-file-storage.js";
import type { ObjectMetadata, ObjectStorage } from "../../src/contracts/object-storage.js";
import type { AddKnowledgeFileMetadataInput, KnowledgeFileMetadata, KnowledgeFileMetadataRepository } from "../../src/contracts/knowledge/knowledge-file-repository.js";

class MemoryObjects implements ObjectStorage {
  readonly values = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array, contentType: string | null = null): Promise<ObjectMetadata> {
    this.values.set(key, new Uint8Array(body));
    return { key, contentType, contentLength: body.byteLength, etag: null };
  }
  async get(key: string) { const body = this.values.get(key); return body ? { body, metadata: { key, contentType: null, contentLength: body.byteLength, etag: null } } : null; }
  async head(key: string) { const body = this.values.get(key); return body ? { key, contentType: null, contentLength: body.byteLength, etag: null } : null; }
  async delete(key: string) { return this.values.delete(key); }
}

class MemoryMetadata implements KnowledgeFileMetadataRepository {
  readonly values = new Map<string, KnowledgeFileMetadata>();
  async list(tenantId: string) { return [...this.values.values()].filter((row) => row.tenant_id === tenantId); }
  async get(tenantId: string, fileId: string) { const row = this.values.get(`${tenantId}:${fileId}`); return row ?? null; }
  async create(input: AddKnowledgeFileMetadataInput) {
    const row: KnowledgeFileMetadata = { ...input, uploaded_at: input.uploaded_at ?? new Date().toISOString(), md_blob_hash: input.md_blob_hash ?? null };
    this.values.set(`${input.tenant_id}:${input.id}`, row); return row;
  }
  async setMarkdownHash(tenantId: string, fileId: string, mdBlobHash: string | null) { const row = this.values.get(`${tenantId}:${fileId}`); if (!row) return false; row.md_blob_hash = mdBlobHash; return true; }
  async delete(tenantId: string, fileId: string) { return this.values.delete(`${tenantId}:${fileId}`); }
}

describe("SaaSKnowledgeFileStorage", () => {
  it("stores bytes under tenant-scoped object keys and round-trips markdown", async () => {
    const objects = new MemoryObjects();
    const store = new SaaSKnowledgeFileStorage("tenant-a", new MemoryMetadata(), objects);
    const file = await store.addKnowledgeFile({ originalName: "guide.txt", buffer: Buffer.from("hello"), mime: "text/plain" });
    expect(file.stored_path).toMatch(/^tenants\/tenant-a\/knowledge\//);
    expect(await store.getSource(file.id)).toMatchObject({ contentType: "text/plain" });
    const markdown = await store.putKnowledgeMarkdown(file.id, "# Hello");
    expect(await store.readKnowledgeMarkdown(markdown.md_blob_hash)).toBe("# Hello");
    await store.deleteKnowledgeFile(file.id);
    expect(await store.getKnowledgeFile(file.id)).toBeNull();
    expect(objects.values.size).toBe(0);
  });

  it("removes the uploaded object when metadata creation fails", async () => {
    const objects = new MemoryObjects();
    const metadata = new MemoryMetadata();
    metadata.create = async () => { throw new Error("db unavailable"); };
    const store = new SaaSKnowledgeFileStorage("tenant-a", metadata, objects);
    await expect(store.addKnowledgeFile({ originalName: "a.txt", buffer: Buffer.from("a"), mime: "text/plain" })).rejects.toThrow("db unavailable");
    expect(objects.values.size).toBe(0);
  });
});
