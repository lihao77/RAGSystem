import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { isPathUnder } from "@ragsystem/backend-core/tools/shared/paths.js";
import { PathApprovalService } from "@ragsystem/backend-core/services/runtime/path-approval-service.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import {
  backendPluginModule,
  createDocumentToolsPlugin,
  createLocalDocumentToolsRuntimeFactory,
  DOCUMENT_TOOLS_RUNTIME_CAPABILITY,
} from "../dist/index.js";
import { SaaSDocumentToolService } from "../dist/storage/saas/sandbox-document-tools.js";
import { READ_FILE_CHAR_BUDGET, READ_FILE_MAX_LINE_CHARS, selectLineRange } from "../dist/tools/shared/document-policy.js";

const descriptorNames = ["read_file", "write_file", "edit_file", "preview_data_structure"];

test("document tool descriptors are contributed only when the plugin is installed", async () => {
  const empty = new BackendPluginManager();
  await empty.register();
  assert.deepEqual(empty.runtimeContributions().listTools(), []);

  const installed = new BackendPluginManager([
    createDocumentToolsPlugin({ runtimeFactory: () => ({ document: null }) }),
  ]);
  await installed.register();
  assert.deepEqual(
    installed.runtimeContributions().listTools().map((tool) => tool.name),
    descriptorNames,
  );
});

test("standard plugin module selects the deployment runtime without product wiring", async () => {
  const plugin = await backendPluginModule.create({ config: undefined });
  const manager = new BackendPluginManager([plugin]);
  await manager.register();
  const contributions = manager.runtimeContributions();

  const local = await contributions.createRuntime({
    deploymentKind: "local",
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.toolPolicy, { executionToolsEnabled: false }, "test-host")],
  });
  assert.deepEqual(local.capabilities.require(DOCUMENT_TOOLS_RUNTIME_CAPABILITY), { document: null });
  local.dispose();

  const supplied = fakeSandboxRuntime();
  const saas = await contributions.createRuntime({
    deploymentKind: "saas",
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.sandboxRuntime, supplied, "test-host")],
  });
  assert.ok(saas.capabilities.require(DOCUMENT_TOOLS_RUNTIME_CAPABILITY).document);
  saas.dispose();
});

test("standard plugin module rejects unsupported configuration", () => {
  assert.throws(
    () => backendPluginModule.create({ config: { unknown: true } }),
    /does not accept configuration/,
  );
});

test("document tool visibility follows the agent enabled_tools list", async () => {
  const manager = new BackendPluginManager([
    createDocumentToolsPlugin({ runtimeFactory: () => ({ document: fakeDocumentPort() }) }),
  ]);
  await manager.register();
  const contributions = manager.runtimeContributions();
  const runtime = await contributions.createRuntime({});

  assert.deepEqual(
    (await contributions.createTools(toolContext(runtime.capabilities, []))).map((tool) => tool.name),
    [],
  );
  assert.deepEqual(
    (await contributions.createTools(toolContext(runtime.capabilities, ["read_file", "edit_file"]))).map((tool) => tool.name),
    ["read_file", "edit_file"],
  );
});

test("local document runtime can be disabled by a deployment resource", () => {
  const factory = createLocalDocumentToolsRuntimeFactory();
  assert.deepEqual(factory({
    deploymentKind: "local",
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.toolPolicy, { executionToolsEnabled: false }, "test-host")],
  }), { document: null });
});

test("local document runtime owns file writes and consumes the edit-history resource", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-tools-"));
  const edits = [];
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
      resources: [provideBackendResource(BACKEND_HOST_RESOURCES.fileEditHistory, { trackEdit: (sessionId, filePath) => edits.push({ sessionId, filePath }) }, "test-host")],
    });
    const result = await runtime.document.writeFile(
      { content: "hello", filePath: "note.txt", filePathSpace: "workspace" },
      { sessionId: "session-a", runId: "run-a" },
      { custom_params: {} },
      {
        isApproved: () => false,
        assertWithin: (candidatePath) => candidatePath,
      },
    );

    assert.equal(result.success, true);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].sessionId, "session-a");
    assert.equal(fs.readFileSync(edits[0].filePath, "utf8"), "hello");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("document relative writes and reads use the same workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-workspace-"));
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
    });
    const context = { sessionId: "session-workspace", runId: "run-workspace" };
    const pathPolicy = {
      isApproved: () => false,
      assertWithin: (candidatePath) => candidatePath,
    };
    const written = await runtime.document.writeFile(
      { content: "workspace content", filePath: "shared.txt" },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(written.success, true, written.summary);
    const read = runtime.document.readFile(
      { filePath: "shared.txt" },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(read.success, true, read.summary);
    assert.equal(read.content, "workspace content");
    assert.equal(read.metadata.file_path, written.metadata.file_path);
    assert.equal(read.metadata.execution_paths.workspace, path.join(root, "sessions", "session-workspace", "workspace"));
    assert.deepEqual(Object.keys(read.metadata.execution_paths).sort(), ["uploads", "workspace"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local and SaaS document adapters share encoding and line-range policy", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-policy-"));
  try {
    const local = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
    }).document;
    const context = { sessionId: "session-policy", runId: "run-policy" };
    const pathPolicy = { isApproved: () => false, assertWithin: (candidatePath) => candidatePath };
    await local.writeFile({ content: "a\nb\nc\n", filePath: "lines.txt" }, context, { custom_params: {} }, pathPolicy);
    const wideContent = Array.from({ length: 9 }, () => "a".repeat(5000)).join("\n");
    await local.writeFile({ content: wideContent, filePath: "wide.txt" }, context, { custom_params: {} }, pathPolicy);

    const contentByPath = (filePath) => (filePath.endsWith("wide.txt") ? { content: wideContent, size: wideContent.length } : { content: "a\nb\nc\n", size: 6 });
    const saas = new SaaSDocumentToolService({
      async readFile(_context, args) { return contentByPath(args.path); },
      async writeFile() { return { size: 0 }; },
      async editFile() { return { size: 0, replacements: 0 }; },
      async previewFile() { return { fileType: "text", fileSize: 6, structure: {} }; },
      async releaseRun() {},
      async closeAll() {},
    });

    const localRead = local.readFile({ filePath: "lines.txt", offset: 2, limit: 1 }, context, { custom_params: {} }, pathPolicy);
    const saasRead = await saas.readFile({ filePath: "lines.txt", offset: 2, limit: 1 }, context);
    assert.equal(localRead.content, saasRead.content);
    for (const key of ["total_lines", "start_line", "end_line", "has_more", "next_offset", "char_truncated", "truncated_lines"]) {
      assert.equal(localRead.metadata[key], saasRead.metadata[key], key);
    }

    // 宽行文件走字符预算截断分支时双端仍一致
    const localWide = local.readFile({ filePath: "wide.txt" }, context, { custom_params: {} }, pathPolicy);
    const saasWide = await saas.readFile({ filePath: "wide.txt" }, context);
    assert.equal(localWide.content, saasWide.content);
    assert.equal(localWide.metadata.char_truncated, true);
    assert.equal(localWide.metadata.truncated_lines, 8);
    assert.equal(localWide.metadata.next_offset, 9);
    for (const key of ["total_lines", "start_line", "end_line", "has_more", "next_offset", "char_truncated", "truncated_lines"]) {
      assert.equal(localWide.metadata[key], saasWide.metadata[key], key);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function toolContext(capabilities, enabledTools) {
  return {
    tenantId: "tenant-a",
    teamName: null,
    agent: {
      agent_name: "tester",
      tools: { enabled_tools: enabledTools },
      custom_params: {},
    },
    pathAccessPolicy: {},
    capabilities,
  };
}

function fakeDocumentPort() {
  return {
    readFile: () => success("read_file"),
    writeFile: async () => success("write_file"),
    editFile: async () => success("edit_file"),
    previewDataStructure: () => success("preview_data_structure"),
    getExternalCandidates: () => [],
  };
}

function success(toolName) {
  return {
    success: true,
    toolName,
    summary: "ok",
    answer: null,
    outputType: "text",
    content: "ok",
    metadata: {},
    files: [],
    llmHint: null,
  };
}

function fakeSandboxRuntime() {
  return {
    async readFile() { return { content: "", size: 0 }; },
    async writeFile() { return { size: 0 }; },
    async editFile() { return { size: 0, replacements: 0 }; },
    async previewFile() { return { fileType: "text", fileSize: 0, structure: {} }; },
    async releaseRun() {},
    async closeAll() {},
  };
}

test("系统临时目录天然可读写：observation 物化文件可回读、temp 可写入", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-temp-"));
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
    });
    const context = { sessionId: "session-temp", runId: "run-temp" };
    // 忠实模拟真实策略语义：assertWithin 内部做 isPathUnder 判定（无审批放行）
    const strictPolicy = {
      isApproved: () => false,
      assertWithin: (candidatePath, roots) => {
        if (roots.some((root) => isPathUnder(candidatePath, root))) return path.resolve(candidatePath);
        throw new Error("路径超出允许的受管目录范围，禁止访问");
      },
    };

    // 1. 在系统 temp 下写入
    const tempTarget = path.join(os.tmpdir(), `ragsystem-document-temp-write-${Date.now()}.txt`);
    const written = await runtime.document.writeFile(
      { content: "temp data", filePath: tempTarget },
      context,
      { custom_params: {} },
      strictPolicy,
    );
    assert.equal(written.success, true, written.summary);
    assert.equal(fs.readFileSync(tempTarget, "utf8"), "temp data");

    // 2. 回读（模拟 observation 物化产物的取回路径）
    const read = await runtime.document.readFile(
      { filePath: tempTarget },
      context,
      { custom_params: {} },
      strictPolicy,
    );
    assert.equal(read.success, true, read.summary);
    assert.equal(read.content, "temp data");

    // 3. 受管目录之外的普通外部路径仍走审批边界（严格策略下抛错）
    const outside = await runtime.document.readFile(
      { filePath: path.join(path.parse(root).root || path.dirname(root), "definitely-outside.txt") },
      context,
      { custom_params: {} },
      strictPolicy,
    );
    assert.equal(outside.success, false);
    assert.match(outside.summary, /超出允许的受管目录范围/);
    fs.rmSync(tempTarget, { force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selectLineRange 字符预算在行数上限之前截断并给出正确续读位置", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line-${index}`).join("\n");
  const selection = selectLineRange(lines, 1, 2000, { charBudget: 50, maxLineChars: 100 });
  assert.equal(selection.charTruncated, true);
  assert.equal(selection.hasMore, true);
  assert.equal(selection.totalLines, 100);
  // "line-0\n"…"line-6\n" 共 49 字符；第 8 行只剩 1 字符预算，截断后仅剩行尾 "\n"，
  // 与前一行的换行连续，被尾部剥除一起去掉 → content 48 字符
  assert.equal(selection.content.length, 48);
  assert.equal(selection.truncatedLines, 1);
  assert.equal(selection.endLine, 8);
  assert.equal(selection.nextOffset, 9);
  assert.ok(selection.content.startsWith("line-0\nline-1"));
  // 续读从下一整行开始
  const rest = selectLineRange(lines, selection.nextOffset, 2000, { charBudget: 10_000, maxLineChars: 100 });
  assert.ok(rest.content.startsWith("line-8"));
});

test("selectLineRange 少行超宽文件被行内截断，短行文件不受影响", () => {
  const wide = Array.from({ length: 3 }, () => "a".repeat(10_000)).join("\n");
  const wideSelection = selectLineRange(wide, 1, 2000, { charBudget: 16_000, maxLineChars: 2_000 });
  assert.equal(wideSelection.totalLines, 3);
  assert.equal(wideSelection.truncatedLines, 3);
  assert.equal(wideSelection.charTruncated, false);
  assert.equal(wideSelection.hasMore, false);
  assert.ok(wideSelection.content.length <= 3 * READ_FILE_MAX_LINE_CHARS);

  const normal = selectLineRange("hello\nworld\n", 1, 2000, {});
  assert.equal(normal.content, "hello\nworld");
  assert.equal(normal.charTruncated, false);
  assert.equal(normal.truncatedLines, 0);
  assert.equal(normal.hasMore, false);
});

test("selectLineRange 截断行保留行尾换行符，相邻行不熔接", () => {
  const wide = `${"a".repeat(3000)}\n${"b".repeat(3000)}\n${"c".repeat(3000)}`;
  const selection = selectLineRange(wide, 1, 2000, { charBudget: 16_000, maxLineChars: 2_000 });
  const segments = selection.content.split("\n");
  assert.deepEqual(segments.map((segment) => segment.length), [1999, 1999, 2000]);
  assert.equal(selection.truncatedLines, 3);
  assert.equal(selection.charTruncated, false);

  const crlf = `${"a".repeat(3000)}\r\n${"b".repeat(3000)}`;
  const crlfSelection = selectLineRange(crlf, 1, 2000, { charBudget: 16_000, maxLineChars: 2_000 });
  assert.ok(crlfSelection.content.includes("\r\n"));
  assert.equal(crlfSelection.content.split("\r\n").length, 2);
});

test("selectLineRange 预算恰好耗尽在最后一行不误报截断", () => {
  const lines = "abcd\n".repeat(4);
  const selection = selectLineRange(lines, 1, 2000, { charBudget: 20, maxLineChars: 100 });
  assert.equal(selection.charTruncated, false);
  assert.equal(selection.hasMore, false);
  assert.equal(selection.endLine, 4);
  assert.equal(selection.nextOffset, null);
});

test("read_file 默认调用对宽行大文件按字符预算分页，不再整文件入上下文", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-wide-"));
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
    });
    const context = { sessionId: "session-wide", runId: "run-wide" };
    const pathPolicy = { isApproved: () => false, assertWithin: (candidatePath) => candidatePath };
    const wideLines = Array.from({ length: 40 }, (_, index) => `data-${index}:${"x".repeat(5000)}`);
    await runtime.document.writeFile(
      { content: wideLines.join("\n"), filePath: "wide.txt" },
      context,
      { custom_params: {} },
      pathPolicy,
    );

    const first = runtime.document.readFile({ filePath: "wide.txt" }, context, { custom_params: {} }, pathPolicy);
    assert.equal(first.success, true, first.summary);
    // 40 行 × 5000+ 字符：单行截到 2000，8 行即耗尽 16000 字符预算
    assert.equal(first.metadata.char_truncated, true);
    assert.equal(first.metadata.truncated_lines, 8);
    assert.equal(first.metadata.end_line, 8);
    assert.equal(first.metadata.next_offset, 9);
    assert.ok(first.content.length <= READ_FILE_CHAR_BUDGET);
    // 每个截断行保留行尾换行：8 行 → 8 段
    assert.equal(first.content.split("\n").length, 8);
    assert.match(first.summary, /字符预算/);
    assert.match(first.summary, /超长/);
    assert.equal("user_approved_full_read" in first.metadata, false);

    let offset = first.metadata.next_offset;
    let reads = 0;
    while (true) {
      const page = runtime.document.readFile({ filePath: "wide.txt", offset }, context, { custom_params: {} }, pathPolicy);
      assert.equal(page.success, true, page.summary);
      assert.ok(page.content.length <= READ_FILE_CHAR_BUDGET);
      reads++;
      assert.ok(reads < 20, "分页必须在有限步内到达文件末尾");
      if (!page.metadata.has_more) {
        assert.equal(page.metadata.end_line, 40);
        break;
      }
      offset = page.metadata.next_offset;
    }
    assert.equal(reads, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preview_data_structure 外部路径按读语义产生审批候选（与 read_file 一致）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-preview-"));
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({
      deploymentKind: "local",
      dataRoot: root,
    });
    const context = { sessionId: "session-preview", runId: "run-preview" };
    const policy = new PathApprovalService();
    const external = path.join(path.parse(root).root || path.dirname(root), "definitely-outside.csv");
    const args = { file_path: external };

    assert.deepEqual(
      runtime.document.getExternalCandidates("preview_data_structure", args, context, policy),
      [external],
    );
    assert.deepEqual(
      runtime.document.getExternalCandidates("read_file", args, context, policy),
      [external],
    );

    policy.approve([external]);
    assert.deepEqual(
      runtime.document.getExternalCandidates("preview_data_structure", args, context, policy),
      [],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
