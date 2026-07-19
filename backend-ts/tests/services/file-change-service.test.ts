import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AsyncFileChangeService, FileChangeService } from "../../src/services/sessions/file-change-service.js";
import type { AsyncFileHistoryStore } from "../../src/contracts/file-history-store/index.js";
import { FileHistoryService } from "../../src/services/stores/file-history-service.js";

let dataRoot: string;
let workDir: string;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), `file-change-${randomUUID()}-`));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), `file-change-work-${randomUUID()}-`));
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("FileChangeService", () => {
  it("reads SaaS current and backup contents through the async object history port", async () => {
    const key = "tenants/tnt_a/sessions/s1/shared/workspace/note.txt";
    const history: AsyncFileHistoryStore = {
      listSnapshots: async () => [{ snapshot_id: "snap-1", message_seq: 7, created_at: "2026-01-01T00:00:00.000Z", tracked_files: { [key]: { action: "modified", backup_hash: "a".repeat(64) } } }],
      getPendingTracked: async () => null,
      readBackup: async () => Buffer.from("before\n"),
      readCurrent: async () => Buffer.from("after\n"),
      trackEdit: async () => undefined,
      makeSnapshot: async () => null,
      rewind: async () => ({ success: true, message: "", reverted_files: 0 }),
      hasSnapshots: async () => true,
      cleanup: async () => undefined,
    };

    await expect(new AsyncFileChangeService(history).getLatest("s1")).resolves.toEqual({
      snapshot_id: "snap-1",
      message_seq: 7,
      files: [{
        path: key,
        action: "modified",
        oldContent: "before\n",
        newContent: "after\n",
        diff: [
          { type: "removed", content: "before", oldLine: 1, newLine: null },
          { type: "added", content: "after", oldLine: null, newLine: 1 },
        ],
      }],
    });
  });

  it("合并最近 snapshot 与持久化 pending", () => {
    const history = new FileHistoryService({ dataRoot });
    const oldFile = path.join(workDir, "old.txt");
    const currentFile = path.join(workDir, "current.txt");
    fs.writeFileSync(oldFile, "old-before\n");
    history.trackEdit("session", oldFile);
    fs.writeFileSync(oldFile, "old-after\n");
    history.makeSnapshot("session", 10);

    fs.writeFileSync(currentFile, "before\n");
    history.trackEdit("session", currentFile);
    fs.writeFileSync(currentFile, "after\n");

    const result = new FileChangeService(new FileHistoryService({ dataRoot })).getLatest("session");

    expect(result.snapshot_id).not.toBeNull();
    expect(result.message_seq).toBe(10);
    expect(result.files.map((file) => file.path)).toEqual([oldFile, currentFile]);
    expect(result.files[1]?.diff.map((line) => line.type)).toEqual(["removed", "added"]);
  });

  it("无 snapshot 但有持久化 pending 时返回 pending 文件", () => {
    const history = new FileHistoryService({ dataRoot });
    const filePath = path.join(workDir, "pending-only.txt");
    fs.writeFileSync(filePath, "before\n");
    history.trackEdit("session", filePath);
    fs.writeFileSync(filePath, "after\n");

    const result = new FileChangeService(new FileHistoryService({ dataRoot })).getLatest("session");

    expect(result.snapshot_id).toBeNull();
    expect(result.message_seq).toBeNull();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe(filePath);
  });

  it("同路径 pending 覆盖最近 snapshot 的 tracked 文件", () => {
    const history = new FileHistoryService({ dataRoot });
    const filePath = path.join(workDir, "same-path.txt");
    fs.writeFileSync(filePath, "v0\n");
    history.trackEdit("session", filePath);
    fs.writeFileSync(filePath, "v1\n");
    history.makeSnapshot("session", 10);
    history.trackEdit("session", filePath);
    fs.writeFileSync(filePath, "v2\n");

    const result = new FileChangeService(new FileHistoryService({ dataRoot })).getLatest("session");

    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.oldContent).toBe("v1\n");
    expect(result.files[0]?.newContent).toBe("v2\n");
  });
});
