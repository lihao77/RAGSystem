import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileChangeService } from "../../src/services/sessions/file-change-service.js";
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
