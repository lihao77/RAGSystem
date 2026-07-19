import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FileHistoryService } from "../../src/adapters/local/files/file-history-service.js";

describe("FileHistoryService", () => {
  it("tracks an existing file once and rewinds later snapshots", () => {
    const dataRoot = makeTempRoot();
    const workspace = path.join(dataRoot, "workspace");
    const filePath = path.join(workspace, "data.txt");
    writeFile(filePath, "original");
    const history = new FileHistoryService({ dataRoot });

    history.trackEdit("s1", filePath);
    writeFile(filePath, "after-r1");
    const firstSnapshot = history.makeSnapshot("s1", 10);
    expect(firstSnapshot).toHaveLength(16);

    history.trackEdit("s1", filePath);
    writeFile(filePath, "after-r2");
    history.makeSnapshot("s1", 20);

    expect(history.rewind("s1", 10)).toMatchObject({ success: true, reverted_files: 1 });
    expect(fs.readFileSync(filePath, "utf8")).toBe("after-r1");
    expect(history.listSnapshots("s1").map((snapshot) => snapshot.message_seq)).toEqual([10]);
  });

  it("removes files that were created after the rewind target", () => {
    const dataRoot = makeTempRoot();
    const filePath = path.join(dataRoot, "workspace", "new.txt");
    const history = new FileHistoryService({ dataRoot });

    history.trackEdit("s2", filePath);
    writeFile(filePath, "created");
    history.makeSnapshot("s2", 10);

    expect(history.rewind("s2", 0)).toMatchObject({ success: true, reverted_files: 1 });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("rewinds pending tracked files without a saved snapshot", () => {
    const dataRoot = makeTempRoot();
    const filePath = path.join(dataRoot, "workspace", "pending.txt");
    const history = new FileHistoryService({ dataRoot });

    history.trackEdit("s3", filePath);
    writeFile(filePath, "pending");

    expect(history.hasSnapshots("s3")).toBe(true);
    expect(history.rewind("s3", 0)).toMatchObject({ success: true, reverted_files: 1 });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("cleans persisted snapshots and in-memory tracked files", () => {
    const dataRoot = makeTempRoot();
    const filePath = path.join(dataRoot, "workspace", "file.txt");
    writeFile(filePath, "content");
    const history = new FileHistoryService({ dataRoot });
    history.trackEdit("s4", filePath);
    history.makeSnapshot("s4", 1);

    history.cleanup("s4");

    expect(history.hasSnapshots("s4")).toBe(false);
    expect(fs.existsSync(path.join(dataRoot, "file-history", "s4"))).toBe(false);
  });
});

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-file-history-"));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}
