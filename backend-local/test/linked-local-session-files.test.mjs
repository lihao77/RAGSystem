import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalSessionFileApplication } from "../dist/adapters/local/application/session-file/local-session-file-application.js";
import { FileIndexService } from "../dist/adapters/local/files/file-index-service.js";

test("linked local session files stay external and follow current source contents", async () => {
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
    assert.equal(record.size, 4);
    assert.deepEqual(await application.validate("session-1", [record.id]), { valid: [record.id], invalid: [] });

    fs.writeFileSync(sourcePath, "updated contents", "utf8");
    assert.deepEqual(await application.validate("session-1", [record.id]), { valid: [record.id], invalid: [] });
    const current = await application.read("session-1", record.id);
    assert.equal(current.status, "found");
    assert.equal(Buffer.from(current.body).toString("utf8"), "updated contents");

    await application.delete("session-1", record.id);
    assert.equal(fs.readFileSync(sourcePath, "utf8"), "updated contents", "deleting a link must not delete its source");
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("a missing linked source does not invalidate its session registration", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-linked-stale-"));
  const sourcePath = path.join(dataRoot, "ocean.nc");
  fs.writeFileSync(sourcePath, "before", "utf8");
  const files = new FileIndexService({ dbPath: ":memory:", dataRoot });
  const application = new LocalSessionFileApplication(files);

  try {
    const record = await application.linkLocal("session-1", { filePath: sourcePath, mime: "application/x-netcdf" });
    fs.unlinkSync(sourcePath);
    assert.deepEqual(await application.validate("session-1", [record.id]), { valid: [record.id], invalid: [] });
    assert.deepEqual(await application.read("session-1", record.id), { status: "content_missing" });
  } finally {
    files.close();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
