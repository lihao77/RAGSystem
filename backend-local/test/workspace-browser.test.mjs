import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalWorkspaceFileApplication } from "../dist/adapters/local/application/workspace-file/local-workspace-file-application.js";

const MAX_DIRECTORY_ENTRIES = 500;

function makeApplication(root) {
  return new LocalWorkspaceFileApplication(
    async () => null,
    async (workspaceId) => (workspaceId === "ws-1" ? root : null),
  );
}

function makeRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("listWorkspaceEntries：目录在前按名称排序，文件带 size，path 为项目内相对路径", async () => {
  const root = makeRoot("ragsystem-ws-list-");
  try {
    fs.writeFileSync(path.join(root, "b.txt"), "12345");
    fs.writeFileSync(path.join(root, "a.md"), "# x");
    fs.mkdirSync(path.join(root, "zeta"));
    fs.mkdirSync(path.join(root, "alpha"));
    const app = makeApplication(root);

    const result = await app.listWorkspaceEntries("ws-1", "");
    assert.equal(result.status, "ok");
    assert.equal(result.truncated, false);
    assert.deepEqual(result.entries.map((entry) => [entry.name, entry.type]), [
      ["alpha", "directory"],
      ["zeta", "directory"],
      ["a.md", "file"],
      ["b.txt", "file"],
    ]);
    assert.equal(result.entries.find((entry) => entry.name === "b.txt").size, 5);
    assert.equal(result.entries.find((entry) => entry.name === "alpha").size, null);

    const nested = await app.listWorkspaceEntries("ws-1", "alpha");
    if (nested.status !== "ok") throw new Error("expected ok");
    fs.writeFileSync(path.join(root, "alpha", "inner.txt"), "hi");
    const reloaded = await app.listWorkspaceEntries("ws-1", "alpha");
    assert.deepEqual(reloaded.entries, [{ name: "inner.txt", path: "alpha/inner.txt", type: "file", size: 2 }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkspaceEntries：条目超过上限时截断并标记 truncated", async () => {
  const root = makeRoot("ragsystem-ws-cap-");
  try {
    const many = path.join(root, "many");
    fs.mkdirSync(many);
    for (let index = 0; index < MAX_DIRECTORY_ENTRIES + 5; index += 1) {
      fs.writeFileSync(path.join(many, `f${String(index).padStart(4, "0")}.txt`), "");
    }
    const app = makeApplication(root);

    const result = await app.listWorkspaceEntries("ws-1", "many");
    assert.equal(result.status, "ok");
    assert.equal(result.truncated, true);
    assert.equal(result.entries.length, MAX_DIRECTORY_ENTRIES);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkspaceEntries：路径逃逸与绝对路径被拒绝，未知项目返回 not_found", async () => {
  const root = makeRoot("ragsystem-ws-guard-");
  try {
    fs.writeFileSync(path.join(root, "secret.txt"), "x");
    const app = makeApplication(root);

    await assert.rejects(() => app.listWorkspaceEntries("ws-1", "../"), /escapes|relative/u);
    await assert.rejects(() => app.listWorkspaceEntries("ws-1", "C:/windows"), /relative/u);

    const unknown = await app.listWorkspaceEntries("ws-missing", "");
    assert.equal(unknown.status, "not_found");

    const missingDir = await app.listWorkspaceEntries("ws-1", "no-such-dir");
    assert.equal(missingDir.status, "not_found");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listWorkspaceEntries：符号链接条目被跳过（不跟随出项目根）", async () => {
  const root = makeRoot("ragsystem-ws-symlink-");
  const outside = makeRoot("ragsystem-ws-outside-");
  try {
    fs.writeFileSync(path.join(root, "real.txt"), "ok");
    let symlinkCreated = true;
    try {
      fs.symlinkSync(outside, path.join(root, "link-to-outside"), "dir");
    } catch {
      // Windows 无开发者模式/管理员权限时无法建符号链接，该环境下跳过此断言
      symlinkCreated = false;
    }
    const app = makeApplication(root);

    const result = await app.listWorkspaceEntries("ws-1", "");
    assert.equal(result.status, "ok");
    assert.deepEqual(result.entries.map((entry) => entry.name), ["real.txt"]);
    if (symlinkCreated) {
      assert.ok(!result.entries.some((entry) => entry.name === "link-to-outside"));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("readWorkspaceEntry：按项目根读取文件，含 etag 与内容类型；越界与缺失返回 not_found 或抛错", async () => {
  const root = makeRoot("ragsystem-ws-read-");
  try {
    fs.writeFileSync(path.join(root, "report.md"), "hello");
    const app = makeApplication(root);

    const found = await app.readWorkspaceEntry("ws-1", "report.md");
    assert.equal(found.status, "found");
    assert.equal(Buffer.from(found.body).toString("utf8"), "hello");
    assert.equal(found.contentType, "text/plain");
    assert.match(found.etag, /^local-ws-/u);

    const missing = await app.readWorkspaceEntry("ws-1", "nope.md");
    assert.equal(missing.status, "not_found");

    const unknownWs = await app.readWorkspaceEntry("ws-missing", "report.md");
    assert.equal(unknownWs.status, "not_found");

    await assert.rejects(() => app.readWorkspaceEntry("ws-1", "../escape.md"), /escapes/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
