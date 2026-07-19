import { describe, expect, it } from "vitest";

import { SaaSWorkspaceBlobStorage } from "../../src/adapters/saas/object-storage/workspace-blob-storage.js";
import type { ObjectMetadata, ObjectStorage } from "../../src/contracts/storage/object-storage.js";
import { EPHEMERAL_WORKSPACE_POLICY } from "../../src/contracts/storage/workspace-blob-storage.js";
import type { AsyncFileHistoryStore } from "../../src/contracts/file-history-store/index.js";

class MemoryObjects implements ObjectStorage {
  readonly values = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array, contentType: string | null = null): Promise<ObjectMetadata> { this.values.set(key, new Uint8Array(body)); return { key, contentType, contentLength: body.byteLength, etag: null }; }
  async get(key: string) { const body = this.values.get(key); return body ? { body, metadata: { key, contentType: "text/plain", contentLength: body.byteLength, etag: null } } : null; }
  async head(key: string) { const body = this.values.get(key); return body ? { key, contentType: null, contentLength: body.byteLength, etag: null } : null; }
  async delete(key: string) { return this.values.delete(key); }
}

describe("SaaSWorkspaceBlobStorage", () => {
  it("isolates durable workspace blobs by tenant, session, and run", async () => {
    const objects = new MemoryObjects();
    const first = new SaaSWorkspaceBlobStorage("tenant-a", objects);
    const second = new SaaSWorkspaceBlobStorage("tenant-b", objects);
    const ref = await first.put({ sessionId: "session-1", runId: "run-1", space: "workspace", relativePath: "reports/result.txt", body: Buffer.from("ok"), contentType: "text/plain" });

    expect(ref.key).toBe("tenants/tenant-a/sessions/session-1/runs/run-1/workspace/reports/result.txt");
    expect(Buffer.from((await first.get({ sessionId: "session-1", runId: "run-1", space: "workspace", relativePath: "reports/result.txt" }))!.body).toString()).toBe("ok");
    expect(await second.get({ sessionId: "session-1", runId: "run-1", space: "workspace", relativePath: "reports/result.txt" })).toBeNull();
  });

  it("rejects absolute and escaping paths", async () => {
    const store = new SaaSWorkspaceBlobStorage("tenant-a", new MemoryObjects());
    await expect(store.put({ sessionId: "s", space: "exports", relativePath: "../secret", body: Buffer.from("x") })).rejects.toThrow("escapes");
    await expect(store.put({ sessionId: "s", space: "exports", relativePath: "/secret", body: Buffer.from("x") })).rejects.toThrow("relative");
  });

  it("tracks the original object before overwriting a workspace blob", async () => {
    const objects = new MemoryObjects();
    const tracked: Array<{ fileKey: string; original: Uint8Array | null }> = [];
    const history = {
      trackEdit: async (input: { fileKey: string; original: Uint8Array | null }) => { tracked.push(input); },
    } as AsyncFileHistoryStore;
    const store = new SaaSWorkspaceBlobStorage("tenant-a", objects, history);
    await store.put({ sessionId: "s1", space: "workspace", relativePath: "note.txt", body: Buffer.from("before") });
    await store.put({ sessionId: "s1", space: "workspace", relativePath: "note.txt", body: Buffer.from("after") });

    expect(tracked).toHaveLength(2);
    expect(tracked[0]).toMatchObject({ fileKey: "tenants/tenant-a/sessions/s1/shared/workspace/note.txt", original: null });
    expect(Buffer.from(tracked[1]!.original!).toString()).toBe("before");
  });

  it("declares transient files as restart-unsafe scratch space", () => {
    expect(EPHEMERAL_WORKSPACE_POLICY).toEqual({ space: "transient", durable: false, survivesRestart: false });
  });
});
