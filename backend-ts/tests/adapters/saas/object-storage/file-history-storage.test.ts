import { describe, expect, it } from "vitest";

import { SaaSFileHistoryStorage } from "../../../../src/adapters/saas/object-storage/file-history-storage.js";
import type { AsyncFileHistoryMetadataRepository, FileHistorySnapshot, FileHistoryTrackedFile } from "../../../../src/contracts/file-history-store/index.js";
import type { ObjectMetadata, ObjectStorage } from "../../../../src/contracts/storage/object-storage.js";

describe("SaaSFileHistoryStorage", () => {
  it("stores backups in object storage and restores tenant objects on rewind", async () => {
    const objects = new MemoryObjects();
    const metadata = new MemoryMetadata();
    const history = new SaaSFileHistoryStorage("tenant-a", metadata, objects);
    const modifiedKey = "tenants/tenant-a/workspace/a.txt";
    const createdKey = "tenants/tenant-a/workspace/new.txt";

    await objects.put(modifiedKey, bytes("old"), "text/plain");
    await history.trackEdit({ sessionId: "session-1", fileKey: modifiedKey, original: bytes("old"), contentType: "text/plain" });
    await history.trackEdit({ sessionId: "session-1", fileKey: createdKey, original: null, contentType: "text/plain" });
    await objects.put(modifiedKey, bytes("changed"), "text/plain");
    await objects.put(createdKey, bytes("created"), "text/plain");
    expect(Buffer.from((await history.readCurrent(modifiedKey))!).toString("utf8")).toBe("changed");
    await expect(history.makeSnapshot("session-1", 11)).resolves.toMatch(/^[a-f0-9]{16}$/);

    await expect(history.rewind("session-1", 10)).resolves.toMatchObject({ success: true, reverted_files: 2 });
    expect(textOf(await objects.get(modifiedKey))).toBe("old");
    expect(await objects.get(createdKey)).toBeNull();
    await expect(history.listSnapshots("session-1")).resolves.toEqual([]);
  });

  it("rejects a target outside the current tenant prefix", async () => {
    const history = new SaaSFileHistoryStorage("tenant-a", new MemoryMetadata(), new MemoryObjects());
    await expect(history.trackEdit({ sessionId: "s1", fileKey: "tenants/tenant-b/a.txt", original: null })).rejects.toThrow("current tenant");
  });
});

class MemoryMetadata implements AsyncFileHistoryMetadataRepository {
  pending: Record<string, FileHistoryTrackedFile> = {};
  snapshots: FileHistorySnapshot[] = [];
  async putPending(_tenant: string, _session: string, key: string, tracked: FileHistoryTrackedFile) { if (this.pending[key]) return false; this.pending[key] = tracked; return true; }
  async getPending() { return { ...this.pending }; }
  async commitSnapshot(_tenant: string, _session: string, snapshot: FileHistorySnapshot) { if (!Object.keys(this.pending).length) return false; snapshot.tracked_files = { ...this.pending }; this.snapshots.push({ ...snapshot }); this.pending = {}; return true; }
  async listSnapshots() { return this.snapshots.map((item) => ({ ...item })); }
  async replaceSnapshots(_tenant: string, _session: string, snapshots: FileHistorySnapshot[]) { this.snapshots = snapshots; this.pending = {}; }
  async cleanup() { this.snapshots = []; this.pending = {}; }
}

class MemoryObjects implements ObjectStorage {
  private readonly values = new Map<string, { body: Uint8Array; metadata: ObjectMetadata }>();
  async put(key: string, body: Uint8Array, contentType: string | null = null) { const metadata = { key, contentType, contentLength: body.byteLength, etag: null }; this.values.set(key, { body: Uint8Array.from(body), metadata }); return metadata; }
  async get(key: string) { return this.values.get(key) ?? null; }
  async head(key: string) { return this.values.get(key)?.metadata ?? null; }
  async delete(key: string) { return this.values.delete(key); }
}

const bytes = (value: string) => Buffer.from(value, "utf8");
const textOf = (value: { body: Uint8Array } | null) => value ? Buffer.from(value.body).toString("utf8") : null;
