import { describe, expect, it } from "vitest";

import { SaaSSessionFileStorage } from "../../src/adapters/saas/object-storage/session-file-storage.js";
import type { ObjectMetadata, ObjectStorage } from "../../src/contracts/object-storage.js";
import type {
  AddSessionFileMetadataInput,
  SessionFileMetadata,
  SessionFileMetadataRepository,
} from "../../src/contracts/session/session-file-storage.js";

class MemoryObjects implements ObjectStorage {
  readonly values = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array, contentType: string | null = null): Promise<ObjectMetadata> {
    this.values.set(key, new Uint8Array(body));
    return { key, contentType, contentLength: body.byteLength, etag: null };
  }
  async get(key: string) {
    const body = this.values.get(key);
    return body ? { body, metadata: { key, contentType: "image/png", contentLength: body.byteLength, etag: null } } : null;
  }
  async head(key: string) { const body = this.values.get(key); return body ? { key, contentType: null, contentLength: body.byteLength, etag: null } : null; }
  async delete(key: string) { return this.values.delete(key); }
}

class MemoryMetadata implements SessionFileMetadataRepository {
  readonly values = new Map<string, SessionFileMetadata>();
  async list(tenantId: string, sessionId: string) { return [...this.values.values()].filter((row) => row.tenant_id === tenantId && row.scope_id === sessionId); }
  async get(tenantId: string, sessionId: string, fileId: string) { return this.values.get(`${tenantId}:${sessionId}:${fileId}`) ?? null; }
  async create(input: AddSessionFileMetadataInput) { const row = { ...input }; this.values.set(`${input.tenant_id}:${input.scope_id}:${input.id}`, row); return row; }
  async delete(tenantId: string, sessionId: string, fileId: string) { return this.values.delete(`${tenantId}:${sessionId}:${fileId}`); }
}

describe("SaaSSessionFileStorage", () => {
  it("stores and reads attachment bytes under a tenant and session key", async () => {
    const objects = new MemoryObjects();
    const metadata = new MemoryMetadata();
    const store = new SaaSSessionFileStorage("tenant-a", metadata, objects);
    const file = await store.add("session-1", { originalName: "screen shot.png", buffer: Buffer.from("image"), mime: "image/png" });

    expect(file.stored_path).toMatch(/^tenants\/tenant-a\/sessions\/session-1\/attachments\//);
    expect(await store.read("session-1", file.id)).toMatchObject({ contentType: "image/png" });
    expect(await store.get("other-session", file.id)).toBeNull();
    expect((await store.list("session-1")).map((entry) => entry.id)).toEqual([file.id]);

    await store.delete("session-1", file.id);
    expect(objects.values.size).toBe(0);
  });

  it("isolates tenants sharing the same session id", async () => {
    const objects = new MemoryObjects();
    const metadata = new MemoryMetadata();
    const first = new SaaSSessionFileStorage("tenant-a", metadata, objects);
    const second = new SaaSSessionFileStorage("tenant-b", metadata, objects);
    const file = await first.add("session-1", { originalName: "a.txt", buffer: Buffer.from("a"), mime: "text/plain" });

    expect(await second.get("session-1", file.id)).toBeNull();
    expect(await second.read("session-1", file.id)).toBeNull();
  });

  it("removes the object when metadata creation fails", async () => {
    const objects = new MemoryObjects();
    const metadata = new MemoryMetadata();
    metadata.create = async () => { throw new Error("db unavailable"); };
    const store = new SaaSSessionFileStorage("tenant-a", metadata, objects);

    await expect(store.add("session-1", { originalName: "a.txt", buffer: Buffer.from("a"), mime: "text/plain" })).rejects.toThrow("db unavailable");
    expect(objects.values.size).toBe(0);
  });
});
