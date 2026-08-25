import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalSessionApplication } from "../dist/adapters/local/application/session/local-session-application.js";
import { LocalWorkspaceFileApplication } from "../dist/adapters/local/application/workspace-file/local-workspace-file-application.js";
import { createLocalExecutionEnvironment } from "@ragsystem/backend-core/contracts/execution/execution-environment.js";

test("未绑定工作区的会话：resolveWorkspaceRoot 回退到执行环境的确定性会话目录", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-ws-fallback-"));
  try {
    const executionEnvironment = createLocalExecutionEnvironment(dataRoot);
    const sessions = { getSession: async () => ({ session_id: "session-1", workspace_id: null }) };
    const conversations = {
      getWorkspaceById: () => { throw new Error("未绑定工作区时不应查询工作区表"); },
    };
    const application = new LocalSessionApplication("tnt_local", sessions, conversations, {}, executionEnvironment);

    const root = await application.resolveWorkspaceRoot("session-1");
    assert.equal(root, path.join(dataRoot, "sessions", "session-1", "workspace"));
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("工具写入兜底会话目录的文件可经 workspace-files 读取（写读同一权威）", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-ws-roundtrip-"));
  try {
    const executionEnvironment = createLocalExecutionEnvironment(dataRoot);
    const sessions = { getSession: async () => ({ session_id: "session-1", workspace_id: null }) };
    const application = new LocalSessionApplication("tnt_local", sessions, {}, {}, executionEnvironment);
    const files = new LocalWorkspaceFileApplication((sessionId) => application.resolveWorkspaceRoot(sessionId));

    const written = path.join(dataRoot, "sessions", "session-1", "workspace", "test_write.txt");
    fs.mkdirSync(path.dirname(written), { recursive: true });
    fs.writeFileSync(written, "hello workspace", "utf8");

    const result = await files.read("session-1", "test_write.txt");
    assert.equal(result.status, "found");
    assert.equal(Buffer.from(result.body).toString("utf8"), "hello workspace");
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("绑定工作区的会话仍解析到工作区表记录的 root_path", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-ws-bound-"));
  try {
    const executionEnvironment = createLocalExecutionEnvironment(dataRoot);
    const sessions = { getSession: async () => ({ session_id: "session-1", workspace_id: "ws-1" }) };
    const conversations = { getWorkspaceById: () => ({ workspace_id: "ws-1", root_path: path.join(dataRoot, "bound-ws") }) };
    const application = new LocalSessionApplication("tnt_local", sessions, conversations, {}, executionEnvironment);

    assert.equal(await application.resolveWorkspaceRoot("session-1"), path.join(dataRoot, "bound-ws"));
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("会话不存在时仍返回 null", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-ws-unknown-"));
  try {
    const executionEnvironment = createLocalExecutionEnvironment(dataRoot);
    const sessions = { getSession: async () => null };
    const application = new LocalSessionApplication("tnt_local", sessions, {}, {}, executionEnvironment);
    assert.equal(await application.resolveWorkspaceRoot("missing"), null);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
