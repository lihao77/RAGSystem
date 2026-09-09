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
import {
  LINE_TRUNCATION_SUFFIX,
  READ_FILE_CHAR_BUDGET,
  READ_FILE_MAX_LINE_CHARS,
  scanStreamWindow,
  selectLineRange,
} from "../dist/tools/shared/document-policy.js";

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
    const read = await runtime.document.readFile(
      { filePath: "shared.txt" },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(read.success, true, read.summary);
    assert.equal(read.content, "1: workspace content\n\n(第 1-1 行，已到文件末尾，共 1 行)");
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

    const localRead = await local.readFile({ filePath: "lines.txt", offset: 2, limit: 1 }, context, { custom_params: {} }, pathPolicy);
    const saasRead = await saas.readFile({ filePath: "lines.txt", offset: 2, limit: 1 }, context);
    assert.equal(localRead.content, saasRead.content);
    for (const key of ["total_lines", "start_line", "end_line", "has_more", "next_offset", "char_truncated", "truncated_lines"]) {
      assert.equal(localRead.metadata[key], saasRead.metadata[key], key);
    }

    // 宽行文件走字符预算截断分支时双端仍一致
    const localWide = await local.readFile({ filePath: "wide.txt" }, context, { custom_params: {} }, pathPolicy);
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
    assert.equal(read.content, "1: temp data\n\n(第 1-1 行，已到文件末尾，共 1 行)");

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
  // 前 8 行各 6 字符共 48；第 9 行只剩 2 字符预算 → "li" + 截断标注，随后预算耗尽
  assert.equal(selection.truncatedLines, 1);
  assert.equal(selection.endLine, 9);
  assert.equal(selection.nextOffset, 10);
  assert.ok(selection.content.startsWith("1: line-0\n2: line-1"));
  assert.ok(selection.content.includes("9: li... (line truncated)"));
  assert.match(selection.content, /第 9 行截断；继续读取用 offset=10/);
  // 续读从下一整行开始，行号保持文件全局行号
  const rest = selectLineRange(lines, selection.nextOffset, 2000, { charBudget: 10_000, maxLineChars: 100 });
  assert.ok(rest.content.startsWith("10: line-9"));
});

test("selectLineRange 少行超宽文件被行内截断，短行文件不受影响", () => {
  const wide = Array.from({ length: 3 }, () => "a".repeat(10_000)).join("\n");
  const wideSelection = selectLineRange(wide, 1, 2000, { charBudget: 16_000, maxLineChars: 2_000 });
  assert.equal(wideSelection.totalLines, 3);
  assert.equal(wideSelection.truncatedLines, 3);
  assert.equal(wideSelection.charTruncated, false);
  assert.equal(wideSelection.hasMore, false);
  // 每行截到 2000 字符 + 截断标注；行号前缀与 footer 是有界的信封开销
  for (const line of wideSelection.numberedLines) {
    assert.equal(line.truncated, true);
    assert.equal(line.text.length, READ_FILE_MAX_LINE_CHARS + LINE_TRUNCATION_SUFFIX.length);
    assert.ok(line.text.endsWith(LINE_TRUNCATION_SUFFIX));
  }

  const normal = selectLineRange("hello\nworld\n", 1, 2000, {});
  assert.equal(normal.content, "1: hello\n2: world\n\n(第 1-2 行，已到文件末尾，共 2 行)");
  assert.equal(normal.charTruncated, false);
  assert.equal(normal.truncatedLines, 0);
  assert.equal(normal.hasMore, false);
});

test("selectLineRange 行号化渲染逐行独立，CRLF 行尾在窗口中归一为 LF", () => {
  const wide = `${"a".repeat(3000)}\n${"b".repeat(3000)}\n${"c".repeat(3000)}`;
  const selection = selectLineRange(wide, 1, 2000, { charBudget: 16_000, maxLineChars: 2_000 });
  // 渲染按行号逐行拼接，截断行不会与相邻行熔接
  assert.deepEqual(selection.numberedLines.map((line) => line.text[0]), ["a", "b", "c"]);
  assert.deepEqual(selection.numberedLines.map((line) => line.number), [1, 2, 3]);
  assert.equal(selection.truncatedLines, 3);
  assert.equal(selection.charTruncated, false);

  const crlf = `${"a".repeat(3000)}\r\n${"b".repeat(3000)}`;
  const crlfSelection = selectLineRange(crlf, 1, 2000, { charBudget: 16_000, maxLineChars: 2_000 });
  assert.equal(crlfSelection.totalLines, 2);
  // 行尾 \r 在窗口渲染中剥除（dsh stripCarriageReturn），不给模型灌回车符
  assert.ok(!crlfSelection.content.includes("\r"));
  assert.equal(crlfSelection.numberedLines.length, 2);
});

test("selectLineRange 预算恰好耗尽在最后一行不误报截断", () => {
  const lines = "abcd\n".repeat(4);
  const selection = selectLineRange(lines, 1, 2000, { charBudget: 20, maxLineChars: 100 });
  assert.equal(selection.charTruncated, false);
  assert.equal(selection.hasMore, false);
  assert.equal(selection.endLine, 4);
  assert.equal(selection.nextOffset, null);
});

test("scanStreamWindow 巨型单行有界扫描：截断可见且总行数精确", async () => {
  // 50 万字符无换行 + 一行短文本；块边界与行边界刻意错开
  const giant = `${"x".repeat(500_000)}\nshort\n`;
  const selection = await scanStreamWindow([giant.slice(0, 300_000), giant.slice(300_000)], 1, 2000, {});
  assert.equal(selection.totalLines, 2);
  assert.equal(selection.truncatedLines, 1);
  assert.equal(selection.numberedLines[0].number, 1);
  assert.equal(selection.numberedLines[0].text.length, READ_FILE_MAX_LINE_CHARS + LINE_TRUNCATION_SUFFIX.length);
  assert.ok(selection.numberedLines[0].text.endsWith(LINE_TRUNCATION_SUFFIX));
  assert.equal(selection.numberedLines[1].text, "short");
  assert.equal(selection.hasMore, false);
});

test("scanStreamWindow offset 超出文件总行数返回空窗口提示", async () => {
  const selection = await scanStreamWindow(["a\nb\n"], 5, 2000, {});
  assert.equal(selection.totalLines, 2);
  assert.equal(selection.numberedLines.length, 0);
  assert.equal(selection.content, "(offset 5 超出文件总行数 2)");
  assert.equal(selection.hasMore, false);

  const empty = await scanStreamWindow([], 1, 2000, {});
  assert.equal(empty.totalLines, 0);
  assert.equal(empty.content, "(空文件)");
});

test("scanStreamWindow 与 selectLineRange 在超长行含 \\r 时逐字一致（截断可见）", async () => {
  // 2000 字符 + 行中 \r + 更多内容：流式缓冲在 2002 上限处截断，
  // 不得把行中的 \r 误当行尾剥掉而伪装成"恰好 2000 字符且未截断"
  const content = `${"a".repeat(2000)}\r${"b".repeat(50)}\nnext line\n`;
  const streamed = await scanStreamWindow([content], 1, 2000, {});
  const synced = selectLineRange(content, 1, 2000, {});
  assert.equal(streamed.content, synced.content);
  assert.equal(streamed.truncatedLines, 1);
  assert.equal(synced.truncatedLines, 1);
  assert.ok(streamed.content.includes(`1: ${"a".repeat(2000)}${LINE_TRUNCATION_SUFFIX}`));
  assert.ok(!streamed.content.includes(`\r${LINE_TRUNCATION_SUFFIX}`));

  // 块边界刻意切在 \r 与行中间：结果仍与整段一致
  const split = await scanStreamWindow([content.slice(0, 1000), content.slice(1000, 2001), content.slice(2001)], 1, 2000, {});
  assert.equal(split.content, synced.content);

  // 完整行自带行尾 \r（CRLF 文件）仍被剥除且不误报截断
  const crlfLine = `${"a".repeat(2000)}\r\nnext\r\n`;
  const crlfStreamed = await scanStreamWindow([crlfLine], 1, 2000, {});
  const crlfSynced = selectLineRange(crlfLine, 1, 2000, {});
  assert.equal(crlfStreamed.content, crlfSynced.content);
  assert.equal(crlfStreamed.truncatedLines, 0);
  assert.ok(!crlfStreamed.content.includes("\r"));
});

test("read_file offset 超出总行数时返回与 SaaS 一致的提示文案", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-oob-"));
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({ deploymentKind: "local", dataRoot: root });
    const context = { sessionId: "session-oob", runId: "run-oob" };
    const pathPolicy = { isApproved: () => false, assertWithin: (candidatePath) => candidatePath };
    await runtime.document.writeFile({ content: "only\n", filePath: "small.txt" }, context, { custom_params: {} }, pathPolicy);

    const read = await runtime.document.readFile(
      { filePath: "small.txt", offset: 5 },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(read.success, true);
    assert.equal(read.content, "(offset 5 超出文件总行数 1)");
    assert.equal(read.metadata.has_more, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("edit_file 匹配不唯一时报出全部命中行号，replace_all 一次替换", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-edit-multi-"));
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({ deploymentKind: "local", dataRoot: root });
    const context = { sessionId: "session-edit-multi", runId: "run-edit-multi" };
    const pathPolicy = { isApproved: () => false, assertWithin: (candidatePath) => candidatePath };
    await runtime.document.writeFile(
      { content: "x\nfoo\ny\nfoo\nz\nfoo\n", filePath: "multi.txt" },
      context,
      { custom_params: {} },
      pathPolicy,
    );

    const ambiguous = await runtime.document.editFile(
      { filePath: "multi.txt", oldString: "foo", newString: "bar" },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(ambiguous.success, false);
    assert.match(ambiguous.summary, /匹配不唯一（找到 3 处，位于第 2, 4, 6 行）/);

    const replaced = await runtime.document.editFile(
      { filePath: "multi.txt", oldString: "foo", newString: "bar", replaceAll: true },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(replaced.success, true, replaced.summary);
    assert.equal(replaced.content.replacements, 3);
    assert.equal(fs.readFileSync(path.join(root, "sessions", "session-edit-multi", "workspace", "multi.txt"), "utf8"), "x\nbar\ny\nbar\nz\nbar\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("edit_file CRLF 文件用 LF old_string 匹配，写回保持 CRLF 行尾", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-edit-crlf-"));
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({ deploymentKind: "local", dataRoot: root });
    const context = { sessionId: "session-edit-crlf", runId: "run-edit-crlf" };
    const pathPolicy = { isApproved: () => false, assertWithin: (candidatePath) => candidatePath };
    await runtime.document.writeFile(
      { content: "alpha\r\nbeta\r\ngamma\r\n", filePath: "crlf.txt" },
      context,
      { custom_params: {} },
      pathPolicy,
    );

    const edited = await runtime.document.editFile(
      { filePath: "crlf.txt", oldString: "beta", newString: "BETA" },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(edited.success, true, edited.summary);
    assert.equal(edited.content.replacements, 1);
    const after = fs.readFileSync(path.join(root, "sessions", "session-edit-crlf", "workspace", "crlf.txt"), "utf8");
    assert.equal(after, "alpha\r\nBETA\r\ngamma\r\n");
    // diff 在 LF 归一文本上计算：CRLF 不产生全文件 diff
    assert.ok(edited.content.diff_preview.includes("-beta"));
    assert.ok(edited.content.diff_preview.includes("+BETA"));
    assert.equal(edited.content.diff_preview.match(/^@@/gm)?.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("edit_file 行首插入的真 unified diff 只产生一个 hunk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-document-edit-diff-"));
  try {
    const runtime = createLocalDocumentToolsRuntimeFactory()({ deploymentKind: "local", dataRoot: root });
    const context = { sessionId: "session-edit-diff", runId: "run-edit-diff" };
    const pathPolicy = { isApproved: () => false, assertWithin: (candidatePath) => candidatePath };
    await runtime.document.writeFile(
      { content: "line1\nline2\nline3\n", filePath: "plain.txt" },
      context,
      { custom_params: {} },
      pathPolicy,
    );

    const edited = await runtime.document.editFile(
      { filePath: "plain.txt", oldString: "line2", newString: "line2\nline2b" },
      context,
      { custom_params: {} },
      pathPolicy,
    );
    assert.equal(edited.success, true, edited.summary);
    const diff = edited.content.diff_preview;
    assert.ok(diff.startsWith("a/plain.txt\nb/plain.txt\n"));
    assert.ok(diff.includes("@@ -2,2 +2,3 @@"));
    assert.equal(diff.match(/^@@/gm)?.length, 1);
    assert.ok(diff.includes("+line2b"));
    assert.ok(diff.includes(" line3"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

    const first = await runtime.document.readFile({ filePath: "wide.txt" }, context, { custom_params: {} }, pathPolicy);
    assert.equal(first.success, true, first.summary);
    // 40 行 × 5000+ 字符：单行截到 2000+标注，8 行即耗尽 16000 字符预算
    assert.equal(first.metadata.char_truncated, true);
    assert.equal(first.metadata.truncated_lines, 8);
    assert.equal(first.metadata.end_line, 8);
    assert.equal(first.metadata.next_offset, 9);
    // 行文本载荷受字符预算约束；行号前缀与 footer 是额外信封开销（本窗口 8 行 < 200 字符）
    assert.ok(first.content.length <= READ_FILE_CHAR_BUDGET + 200);
    // 8 行行号化正文 + 空行 + footer
    assert.equal(first.content.split("\n").length, 10);
    assert.match(first.summary, /字符预算/);
    assert.match(first.summary, /超长/);
    assert.equal("user_approved_full_read" in first.metadata, false);

    let offset = first.metadata.next_offset;
    let reads = 0;
    while (true) {
      const page = await runtime.document.readFile({ filePath: "wide.txt", offset }, context, { custom_params: {} }, pathPolicy);
      assert.equal(page.success, true, page.summary);
      assert.ok(page.content.length <= READ_FILE_CHAR_BUDGET + 200);
      reads++;
      assert.ok(reads < 20, "分页必须在有限步内到达文件末尾");
      if (!page.metadata.has_more) {
        assert.equal(page.metadata.end_line, 40);
        break;
      }
      offset = page.metadata.next_offset;
    }
    // 首读覆盖 1-8 行，循环内再读 4 页（9-16/17-24/25-32/33-40）到达末尾
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
