import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalSessionFileApplication } from "../dist/adapters/local/application/session-file/local-session-file-application.js";
import { FileIndexService } from "../dist/adapters/local/files/file-index-service.js";
import { isCurrentLinkedLocalRecord } from "../dist/adapters/local/files/linked-local-file.js";

test("linked local session files stay external and are verified by SHA-256", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-linked-local-"));
  const externalRoot = path.join(dataRoot, "sessions", "session-1", "uploads");
  const sourcePath = path.join(externalRoot, "external.nc");
  fs.mkdirSync(externalRoot, { recursive: true });
  fs.writeFileSync(sourcePath, "ABCD", "utf8");
  const files = new FileIndexService({ dbPath: ":memory:", dataRoot });
  const application = new LocalSessionFileApplication(files);

  try {
    const record = await application.linkLocal("session-1", {
      filePath: sourcePath,
      mime: "application/x-netcdf",
    });
    assert.equal(record.storage_kind, "linked_local");
    assert.equal(record.local_path, fs.realpathSync(sourcePath));
    assert.equal(record.source_sha256, sha256("ABCD"));
    assert.deepEqual(await application.validate("session-1", [record.id]), { valid: [record.id], invalid: [] });

    const currentStats = fs.statSync(sourcePath);
    const forgedRecord = {
      ...record,
      size: currentStats.size,
      source_mtime_ms: currentStats.mtimeMs,
      source_sha256: sha256("WXYZ"),
    };
    assert.equal(await isCurrentLinkedLocalRecord(forgedRecord), false, "content hash must be checked even when metadata matches");

    await application.delete("session-1", record.id);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), "ABCD", "deleting a link must not delete its source");
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("linked local session files become invalid after their contents change", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-linked-stale-"));
  const sourcePath = path.join(dataRoot, "ocean.nc");
  fs.writeFileSync(sourcePath, "before", "utf8");
  const files = new FileIndexService({ dbPath: ":memory:", dataRoot });
  const application = new LocalSessionFileApplication(files);

  try {
    const record = await application.linkLocal("session-1", { filePath: sourcePath, mime: "application/x-netcdf" });
    fs.writeFileSync(sourcePath, "after!", "utf8");
    assert.deepEqual(await application.validate("session-1", [record.id]), { valid: [], invalid: [record.id] });
    assert.deepEqual(await application.read("session-1", record.id), { status: "content_missing" });
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
