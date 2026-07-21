import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { LocalFileChangeApplication } from "../../src/adapters/local/application/file-change/local-file-change-application.js";
import { LocalSessionFileApplication } from "../../src/adapters/local/application/session-file/local-session-file-application.js";
import { FileHistoryService } from "../../src/adapters/local/files/file-history-service.js";
import { FileIndexService } from "../../src/adapters/local/files/file-index-service.js";
import { SaaSFileChangeApplication } from "../../src/adapters/saas/application/file-change/saas-file-change-application.js";
import { SaaSSessionFileApplication } from "../../src/adapters/saas/application/session-file/saas-session-file-application.js";
import { SaaSSessionFileStorage } from "../../src/adapters/saas/object-storage/session-file-storage.js";
import type { FileChangeApplication } from "../../src/contracts/application/file-change-application.js";
import type { SessionFileApplication } from "../../src/contracts/application/session-file-application.js";
import type { AsyncFileHistoryStore, FileHistorySnapshot, FileHistoryTrackedFile } from "../../src/contracts/file-history-store/index.js";
import type {
  AddSessionFileMetadataInput,
  SessionFileMetadata,
  SessionFileMetadataRepository,
} from "../../src/contracts/session/session-file-storage.js";
import type { ObjectMetadata, ObjectStorage } from "../../src/contracts/storage/object-storage.js";
import { makeTempRoot } from "../helpers/temp-db.js";

interface SessionFileHarness {
  application: SessionFileApplication;
  close(): void;
}

runSessionFileContract("Local filesystem", () => {
  const root = makeTempRoot();
  const index = new FileIndexService({ dbPath: ":memory:", dataRoot: root });
  return { application: new LocalSessionFileApplication(index), close: () => index.close() };
});

runSessionFileContract("SaaS object storage", () => {
  const storage = new SaaSSessionFileStorage("tenant-a", new MemoryMetadata(), new MemoryObjects());
  return { application: new SaaSSessionFileApplication(storage), close: () => undefined };
});

function runSessionFileContract(label: string, createHarness: () => SessionFileHarness): void {
  describe(`${label} SessionFileApplication contract`, () => {
    it("adds, scopes, validates, reads, lists, and deletes one attachment", async () => {
      const harness = createHarness();
      try {
        const added = await harness.application.add("session-1", {
          originalName: "notes.txt",
          buffer: new TextEncoder().encode("hello"),
          mime: "text/plain",
        });

        expect(await harness.application.list("session-1")).toEqual([
          expect.objectContaining({ id: added.id, original_name: "notes.txt", scope_id: "session-1" }),
        ]);
        expect(await harness.application.get("other-session", added.id)).toBeNull();
        expect(await harness.application.validate("session-1", [added.id, "missing"])).toEqual({
          valid: [added.id],
          invalid: ["missing"],
        });
        const source = await harness.application.read("session-1", added.id);
        expect(source.status).toBe("found");
        if (source.status === "found") {
          expect(new TextDecoder().decode(source.body)).toBe("hello");
          expect(source.contentType).toBe("text/plain");
        }
        expect(await harness.application.delete("session-1", added.id)).toMatchObject({ id: added.id });
        expect(await harness.application.read("session-1", added.id)).toEqual({ status: "not_found" });
      } finally {
        harness.close();
      }
    });
  });
}

describe("FileChangeApplication contract", () => {
  it.each(["local", "saas"] as const)("projects the latest %s modified file with the same DTO", async (kind) => {
    const root = makeTempRoot();
    const filePath = path.join(root, "notes.txt");
    let application: FileChangeApplication;
    if (kind === "local") {
      fs.writeFileSync(filePath, "old\n", "utf8");
      const history = new FileHistoryService({ dataRoot: root });
      history.trackEdit("session-1", filePath);
      fs.writeFileSync(filePath, "new\n", "utf8");
      history.makeSnapshot("session-1", 7);
      application = new LocalFileChangeApplication(history);
    } else {
      application = new SaaSFileChangeApplication(new StaticAsyncHistory(filePath));
    }

    expect(await application.getLatest("session-1")).toMatchObject({
      message_seq: 7,
      files: [{
        path: filePath,
        action: "modified",
        oldContent: "old\n",
        newContent: "new\n",
        diff: [
          expect.objectContaining({ type: "removed", content: "old" }),
          expect.objectContaining({ type: "added", content: "new" }),
        ],
      }],
    });
  });
});

class MemoryObjects implements ObjectStorage {
  private readonly values = new Map<string, { body: Uint8Array; contentType: string | null }>();

  async put(key: string, body: Uint8Array, contentType: string | null = null): Promise<ObjectMetadata> {
    this.values.set(key, { body: new Uint8Array(body), contentType });
    return { key, contentType, contentLength: body.byteLength, etag: null };
  }
  async get(key: string) {
    const value = this.values.get(key);
    return value ? {
      body: value.body,
      metadata: { key, contentType: value.contentType, contentLength: value.body.byteLength, etag: null },
    } : null;
  }
  async head(key: string) {
    const value = this.values.get(key);
    return value ? { key, contentType: value.contentType, contentLength: value.body.byteLength, etag: null } : null;
  }
  async delete(key: string) { return this.values.delete(key); }
}

class MemoryMetadata implements SessionFileMetadataRepository {
  private readonly values = new Map<string, SessionFileMetadata>();
  async list(tenantId: string, sessionId: string) {
    return [...this.values.values()].filter((row) => row.tenant_id === tenantId && row.scope_id === sessionId);
  }
  async get(tenantId: string, sessionId: string, fileId: string) {
    return this.values.get(`${tenantId}:${sessionId}:${fileId}`) ?? null;
  }
  async create(input: AddSessionFileMetadataInput) {
    const row = { ...input };
    this.values.set(`${input.tenant_id}:${input.scope_id}:${input.id}`, row);
    return row;
  }
  async delete(tenantId: string, sessionId: string, fileId: string) {
    return this.values.delete(`${tenantId}:${sessionId}:${fileId}`);
  }
}

class StaticAsyncHistory implements AsyncFileHistoryStore {
  private readonly tracked: Record<string, FileHistoryTrackedFile>;
  private readonly snapshots: FileHistorySnapshot[];

  constructor(private readonly fileKey: string) {
    this.tracked = { [fileKey]: { action: "modified", backup_hash: "backup" } };
    this.snapshots = [{ snapshot_id: "snapshot", message_seq: 7, tracked_files: this.tracked, created_at: "2026-01-01T00:00:00.000Z" }];
  }

  async trackEdit() {}
  async makeSnapshot() { return "snapshot"; }
  async rewind() { return { success: true, message: "ok", reverted_files: 1 }; }
  async hasSnapshots() { return true; }
  async listSnapshots() { return this.snapshots; }
  async getPendingTracked() { return null; }
  async readBackup() { return new TextEncoder().encode("old\n"); }
  async readCurrent(fileKey: string) { return fileKey === this.fileKey ? new TextEncoder().encode("new\n") : null; }
  async cleanup() {}
}
