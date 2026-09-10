import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { createRuntime } from "@ragsystem/agent-sdk";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { detectHostShell } from "@ragsystem/backend-core/contracts/execution/shell-detection.js";
import { PathApprovalService } from "@ragsystem/backend-core/services/runtime/path-approval-service.js";
import {
  backendPluginModule,
  CodeExecutionToolService,
  createExecutionToolsPlugin,
  createLocalExecutionToolsRuntimeFactory,
  EXECUTION_TOOLS_PLUGIN_ID,
  EXECUTION_TOOLS_RUNTIME_CAPABILITY,
  ManagedPathResolver,
  readHostShellOverride,
} from "../dist/index.js";
import { LocalBashToolService } from "../dist/tools/BashTool/BashExecution.js";
import { classifyBashCommand } from "../dist/tools/BashTool/bash-policy.js";
import { LocalSearchToolService } from "../dist/tools/LocalSearchTools/SearchExecution.js";
import { DEFAULT_WEB_FETCH_LIMITS, WebFetchClient } from "../dist/tools/WebFetchTool/web-fetch-client.js";
import { isPublicIpAddress, resolvePublicAddresses } from "../dist/tools/WebFetchTool/web-fetch-network.js";
import { HTML_OMISSION_MARKER, htmlToMarkdown } from "../dist/tools/WebFetchTool/web-fetch-markdown.js";
import { SaaSCodeExecutionService, SaaSSearchToolService } from "../dist/storage/saas/sandbox-execution-tools.js";

const descriptors = [
  "glob",
  "grep",
  "web_fetch",
  "todo_write",
  "execute_shell",
  "execute_code",
];

test("execution tool descriptors are contributed only when the plugin is installed", async () => {
  const empty = new BackendPluginManager();
  await empty.register();
  assert.deepEqual(empty.runtimeContributions().listTools(), []);

  const installed = new BackendPluginManager([
    createExecutionToolsPlugin({ runtimeFactory: () => emptyRuntime() }),
  ]);
  await installed.register();
  assert.deepEqual(
    installed.runtimeContributions().listTools().map((tool) => tool.name),
    descriptors,
  );
});

test("retired tool names declared by the descriptor flow into the core normalization layer", async () => {
  // 端到端：插件在描述符里声明 execute_bash → execute_shell，plugin-manager 聚合进
  // core 注册表，core 的配置归一层（无插件知识）据此收敛存量 enabled_tools。
  const manager = new BackendPluginManager([
    createExecutionToolsPlugin({ runtimeFactory: () => emptyRuntime() }),
  ]);
  await manager.register();

  const { retiredToolNameAliases } = await import("@ragsystem/backend-core/contracts/agent/tool-name-aliases.js");
  assert.equal(retiredToolNameAliases().execute_bash, "execute_shell");

  const { normalizeConfig } = await import("@ragsystem/backend-core/contracts/agent/config-normalize.js");
  const { AgentConfigSchema } = await import("@ragsystem/backend-core/contracts/agent/agent-config.js");
  const normalized = normalizeConfig(AgentConfigSchema.parse({
    agent_name: "legacy",
    tools: { enabled_tools: ["read_file", "execute_bash"] },
  }));
  assert.deepEqual(normalized.tools.enabled_tools, ["read_file", "execute_shell"]);
});

test("standard plugin module selects the deployment runtime without product wiring", async () => {
  assert.equal(backendPluginModule.apiVersion, 1);
  const plugin = await backendPluginModule.create({ config: undefined });
  const manager = new BackendPluginManager([plugin]);
  await manager.register();
  const contributions = manager.runtimeContributions();

  const local = await contributions.createRuntime({
    deploymentKind: "local",
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.toolPolicy, { executionToolsEnabled: false }, "test-host")],
  });
  assert.deepEqual(local.capabilities.require(EXECUTION_TOOLS_RUNTIME_CAPABILITY), emptyRuntime());
  local.dispose();

  const supplied = fakeSandboxRuntime();
  const saas = await contributions.createRuntime({
    deploymentKind: "saas",
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.sandboxRuntime, supplied, "test-host")],
  });
  const saasRuntime = saas.capabilities.require(EXECUTION_TOOLS_RUNTIME_CAPABILITY);
  assert.ok(saasRuntime.bash);
  assert.ok(saasRuntime.code);
  assert.ok(saasRuntime.search);
  saas.dispose();
});

test("standard plugin module rejects unsupported configuration", () => {
  assert.throws(
    () => backendPluginModule.create({ config: { unknown: true } }),
    /does not accept configuration/,
  );
});

test("execution tool visibility follows the agent enabled_tools list", async () => {
  const manager = new BackendPluginManager([
    createExecutionToolsPlugin({
      runtimeFactory: () => ({
        bash: null,
        code: { executeCode: async () => success("execute_code") },
        search: null,
      }),
    }),
  ]);
  await manager.register();
  const contributions = manager.runtimeContributions();
  const runtime = await contributions.createRuntime({});

  assert.deepEqual(
    (await contributions.createTools(toolContext(runtime.capabilities, []))).map((tool) => tool.name),
    [],
  );
  assert.deepEqual(
    (await contributions.createTools(toolContext(runtime.capabilities, ["execute_code"]))).map((tool) => tool.name),
    ["execute_code"],
  );
});

test("local execution runtime can be disabled by a deployment resource", () => {
  const factory = createLocalExecutionToolsRuntimeFactory();
  assert.deepEqual(factory({
    deploymentKind: "local",
    resources: [provideBackendResource(BACKEND_HOST_RESOURCES.toolPolicy, { executionToolsEnabled: false }, "test-host")],
  }), emptyRuntime());
});

test("execute_code receives the generic plugin callTool callback", async () => {
  let receivedCaller = null;
  let receivedContext = null;
  const manager = new BackendPluginManager([
    createExecutionToolsPlugin({
      runtimeFactory: () => ({
        bash: null,
        code: {
          executeCode: async (_input, _context, caller) => {
            receivedCaller = caller;
            return success("execute_code");
          },
        },
        search: null,
      }),
    }),
  ]);
  await manager.register();
  const contributions = manager.runtimeContributions();
  const runtime = await contributions.createRuntime({});
  const callTool = async (_toolName, _args, context) => {
    receivedContext = context;
    return success("nested");
  };
  const [tool] = await contributions.createTools({
    ...toolContext(runtime.capabilities, ["execute_code"]),
    callTool,
  });

  await tool.call({ code: "result = 1" }, {});
  assert.equal(typeof receivedCaller, "function");
  await receivedCaller("nested", {}, {});
  assert.equal(receivedContext.caller, "code_execution");
});

test("managed paths share one deterministic workspace view across execution tools", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-managed-paths-"));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-external-path-"));
  try {
    const resolver = new ManagedPathResolver(dataRoot);
    const context = {
      sessionId: "session-a",
      runId: "run-a",
    };
    const roots = resolver.roots(context);
    for (const root of Object.values(roots)) fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(roots.workspace, "root.txt"), "root", "utf8");

    const pathPolicy = new PathApprovalService();
    assert.equal(resolver.resolveWorkingDirectory(null, context, pathPolicy), roots.workspace);
    assert.equal(resolver.resolveWorkingDirectory(".", context, pathPolicy), roots.workspace);
    assert.equal(resolver.toDisplayPath(roots.workspace), roots.workspace);

    const bash = new LocalBashToolService({ dataRoot, pathResolver: resolver });
    const bashPlan = bash.prepareExecution({ command: "pwd" }, context, null, pathPolicy);
    assert.equal(bashPlan.ok, true);
    assert.equal(bashPlan.plan.cwd, roots.workspace);

    const search = new LocalSearchToolService({ dataRoot, pathResolver: resolver });
    const globResult = await search.glob({ pattern: "*.txt" }, context);
    assert.equal(globResult.success, true);
    assert.equal(globResult.metadata.base_path, roots.workspace);
    assert.deepEqual(globResult.content.files, ["root.txt"]);

    const code = new CodeExecutionToolService({ dataRoot, pathResolver: resolver });
    assert.deepEqual(code.getManagedRoots(context), roots);

    const otherSessionRoots = resolver.roots({ sessionId: "session-b", runId: "run-a" });
    const otherRunRoots = resolver.roots({ sessionId: "session-a", runId: "run-b" });
    assert.notEqual(otherSessionRoots.workspace, roots.workspace);
    assert.equal(otherRunRoots.workspace, roots.workspace);

    assert.deepEqual(resolver.getExternalCandidates(externalRoot, context, pathPolicy), [externalRoot]);
    assert.throws(
      () => resolver.resolveWorkingDirectory(externalRoot, context, pathPolicy),
      /超出允许的受管目录范围/,
    );
    pathPolicy.approve([externalRoot]);
    assert.equal(resolver.resolveWorkingDirectory(externalRoot, context, pathPolicy), externalRoot);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("glob and grep apply read-path approval outside managed roots", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-search-approval-"));
  // os.tmpdir() 属于读语义界内根，外部搜索根必须建在仓库目录下才真正越界
  const externalRoot = path.join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-external-search");
  fs.rmSync(externalRoot, { recursive: true, force: true });
  fs.mkdirSync(externalRoot, { recursive: true });
  try {
    const resolver = new ManagedPathResolver(dataRoot);
    const context = { sessionId: "session-a", runId: "run-a" };
    const roots = resolver.roots(context);
    fs.mkdirSync(roots.workspace, { recursive: true });
    fs.writeFileSync(path.join(externalRoot, "needle.txt"), "needle-content", "utf8");

    const pathPolicy = new PathApprovalService();
    const search = new LocalSearchToolService({ dataRoot, pathResolver: resolver });

    // 未批准的外部搜索根 → checkAccess 候选信号；call 阶段转为工具错误
    assert.deepEqual(search.getSearchRootCandidates(externalRoot, context, pathPolicy), [externalRoot]);
    const rejected = await search.glob({ pattern: "*.txt", path: externalRoot }, context, pathPolicy);
    assert.equal(rejected.success, false);
    assert.match(rejected.summary, /受管目录范围/);

    pathPolicy.approve([externalRoot]);
    const globResult = await search.glob({ pattern: "*.txt", path: externalRoot }, context, pathPolicy);
    assert.equal(globResult.success, true);
    assert.deepEqual(globResult.content.files, ["needle.txt"]);
    const grepResult = await search.grep({ pattern: "needle", path: externalRoot }, context, pathPolicy);
    assert.equal(grepResult.success, true);
    assert.equal(grepResult.content.matches.length, 1);

    // 已批准后不再产生候选信号
    assert.deepEqual(search.getSearchRootCandidates(externalRoot, context, pathPolicy), []);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("search tools run on the ripgrep engine with unified semantics", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-search-rg-"));
  try {
    const resolver = new ManagedPathResolver(dataRoot);
    const context = { sessionId: "session-rg", runId: "run-rg" };
    const workspace = resolver.roots(context).workspace;
    fs.mkdirSync(path.join(workspace, "ignored"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "sub"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "app.ts"), "const version = 42;\nconst name = 'ragsystem';\n", "utf8");
    fs.writeFileSync(path.join(workspace, "sub/note.md"), "see v2 notes\n", "utf8");
    fs.writeFileSync(path.join(workspace, ".hidden.conf"), "secret_token = 1\n", "utf8");
    fs.writeFileSync(path.join(workspace, ".ignore"), "ignored/\n", "utf8");
    fs.writeFileSync(path.join(workspace, ".git/config"), "version in vcs metadata\n", "utf8");
    fs.writeFileSync(path.join(workspace, "ignored/skip.txt"), "version in ignored dir\n", "utf8");
    fs.writeFileSync(path.join(workspace, "case.txt"), "NEEDLE upper\nneedle lower\n", "utf8");

    const search = new LocalSearchToolService({ dataRoot, pathResolver: resolver });

    // pattern 是 ripgrep 正则：v\d+ 命中 "v2"（字面量匹配下不可能）
    const regex = await search.grep({ pattern: "v\\d+" }, context);
    assert.equal(regex.success, true, regex.summary);
    assert.ok(regex.content.matches.some((match) => match.file === "sub/note.md" && match.line.includes("v2")));

    // path 指向单个文件（dsh "File or directory to search"）：只搜该文件，
    // 命中行号与 read_file 的行号锚点一致；base_path 报告被搜的文件本身
    const singleFile = await search.grep({ pattern: "needle", path: "case.txt" }, context);
    assert.equal(singleFile.success, true, singleFile.summary);
    assert.equal(singleFile.content.matches.length, 1);
    assert.equal(singleFile.content.matches[0].file, "case.txt");
    assert.equal(singleFile.content.matches[0].line_number, 2);
    assert.equal(singleFile.content.matches[0].line, "needle lower");
    assert.equal(singleFile.content.base_path, path.join(workspace, "case.txt"));
    // 同一文件用 case_sensitive=false 双命中，行号从 1 计
    const singleInsensitive = await search.grep({ pattern: "needle", path: "case.txt", caseSensitive: false }, context);
    assert.deepEqual(
      singleInsensitive.content.matches.map((match) => match.line_number),
      [1, 2],
    );
    // glob 的文件发现语义不接受文件目标
    const globOnFile = await search.glob({ pattern: "*.txt", path: "case.txt" }, context);
    assert.equal(globOnFile.success, false);
    assert.match(globOnFile.summary, /路径不是目录/);

    // 默认大小写敏感；case_sensitive=false 才忽略大小写
    const sensitive = await search.grep({ pattern: "needle", glob: "case.txt" }, context);
    assert.equal(sensitive.success, true, sensitive.summary);
    assert.equal(sensitive.content.matches.length, 1);
    const insensitive = await search.grep({ pattern: "needle", glob: "case.txt", caseSensitive: false }, context);
    assert.equal(insensitive.content.matches.length, 2);

    // .ignore 忽略规则被尊重（ignored/ 与 VCS 元数据不命中），隐藏文件可搜索
    const ignored = await search.grep({ pattern: "version" }, context);
    assert.equal(ignored.content.matches.length, 1);
    assert.equal(ignored.content.matches[0].file, "app.ts");
    const hidden = await search.grep({ pattern: "secret_token" }, context);
    assert.equal(hidden.content.matches.length, 1);
    assert.equal(hidden.content.matches[0].file, ".hidden.conf");
    assert.ok(hidden.content.scanned_files >= 1, "scanned_files 来自 rg summary.stats.searches");

    // context_lines 重建前后文
    const withContext = await search.grep({ pattern: "name = 'ragsystem'", glob: "app.ts", contextLines: 1 }, context);
    const contextMatch = withContext.content.matches[0];
    assert.deepEqual(contextMatch.before, ["const version = 42;"]);
    assert.deepEqual(contextMatch.after, []);

    // 远距匹配间的 context 行不得串进前一匹配的 after（rg 连续输出两段 context）
    const spread = Array.from({ length: 13 }, (_, i) => `l${i + 1}`).map((line, i) => (i === 1 || i === 11 ? `${line} HIT` : line));
    fs.writeFileSync(path.join(workspace, "spread.txt"), `${spread.join("\n")}\n`, "utf8");
    const distant = await search.grep({ pattern: "HIT", glob: "spread.txt", contextLines: 2 }, context);
    assert.equal(distant.content.matches.length, 2);
    assert.deepEqual(distant.content.matches[0].after, ["l3", "l4"], "after 只取紧邻的 N 行");
    assert.deepEqual(distant.content.matches[1].before, ["l10", "l11"]);
    assert.equal(distant.content.matches[0].after.length, 2, "after 不得超过 contextLines");

    // 诚实截断：恰好满额不误报，超出的报告 total_matches
    const exact = await search.grep({ pattern: "needle", glob: "case.txt", maxResults: 1 }, context);
    assert.equal(exact.content.truncated, false, "恰好满额不得误报截断");
    assert.equal(exact.content.total_matches, 1);
    const capped = await search.grep({ pattern: "(?i)needle", glob: "case.txt", maxResults: 1 }, context);
    assert.equal(capped.content.count, 1);
    assert.equal(capped.content.total_matches, 2);
    assert.equal(capped.content.truncated, true);

    // glob：穿透 ignore/hidden、mtime 排序、VCS 目录排除、诚实截断
    const jan = new Date("2024-01-01T00:00:00Z");
    const feb = new Date("2024-02-01T00:00:00Z");
    const mar = new Date("2024-03-01T00:00:00Z");
    const apr = new Date("2024-04-01T00:00:00Z");
    fs.writeFileSync(path.join(workspace, "old.txt"), "old", "utf8");
    fs.writeFileSync(path.join(workspace, "ignored/new.txt"), "new", "utf8");
    fs.utimesSync(path.join(workspace, "ignored/skip.txt"), jan, jan);
    fs.utimesSync(path.join(workspace, "old.txt"), feb, feb);
    fs.utimesSync(path.join(workspace, "ignored/new.txt"), mar, mar);
    fs.utimesSync(path.join(workspace, "case.txt"), apr, apr);
    const globAll = await search.glob({ pattern: "**/*.txt" }, context);
    assert.equal(globAll.success, true, globAll.summary);
    assert.deepEqual(globAll.content.files, ["ignored/skip.txt", "old.txt", "ignored/new.txt", "case.txt", "spread.txt"]);
    assert.equal(globAll.content.total_files, 5);
    assert.equal(globAll.content.truncated, false);
    const globCapped = await search.glob({ pattern: "**/*.txt", maxResults: 2 }, context);
    assert.deepEqual(globCapped.content.files, ["ignored/skip.txt", "old.txt"]);
    assert.equal(globCapped.content.total_files, 5);
    assert.equal(globCapped.content.truncated, true);
    const globAny = await search.glob({ pattern: "**/*" }, context);
    assert.equal(globAny.content.files.some((file) => file.startsWith(".git/")), false, "VCS 元数据目录必须排除");
    assert.equal(globAny.content.files.includes(".hidden.conf"), true, "发现语义包含隐藏文件");

    // 非法正则显式报错（ripgrep 拒绝），不静默空结果
    const invalid = await search.grep({ pattern: "a(b" }, context);
    assert.equal(invalid.success, false);
    assert.match(invalid.summary, /pattern 非法/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("search policy defaults align with ripgrep semantics and cap line previews", async () => {
  const { normalizeGrepInput, normalizeGlobInput, previewLine } = await import("../dist/tools/shared/search-policy.js");

  const grep = normalizeGrepInput({ pattern: "x" });
  assert.equal(grep.caseSensitive, true, "默认大小写敏感");
  assert.equal(grep.maxResults, 250);
  assert.equal(grep.contextLines, 0);
  assert.deepEqual(normalizeGrepInput({ pattern: "x", caseSensitive: false }).caseSensitive, false);
  assert.equal(normalizeGrepInput({ pattern: "x", maxResults: 99_999 }).maxResults, 5_000, "上限钳制");

  const glob = normalizeGlobInput({ pattern: "*.ts" });
  assert.equal(glob.maxResults, 100);
  assert.equal(glob.recursive, true, "wire 契约恒传 recursive=true");

  const ascii = previewLine("a".repeat(3_000));
  assert.ok(ascii.endsWith(" (line truncated)"));
  const chinese = previewLine("中".repeat(1_000));
  assert.ok(chinese.endsWith(" (line truncated)"));
  assert.ok(!chinese.includes("\uFFFD"), "截断必须落在 UTF-8 序列边界");
  assert.equal(previewLine("short"), "short");
});

test("SaaS search adapter previews long lines and surfaces honest totals", async () => {
  const longLine = "x".repeat(3_000);
  const sandbox = {
    async glob() { return { files: ["a.txt", "b.txt"], truncated: true, totalFiles: 7 }; },
    async grep() {
      return {
        matches: [{ file: "a.txt", lineNumber: 3, line: longLine, before: [], after: [] }],
        scannedFiles: 2,
        truncated: true,
        totalMatches: 9,
      };
    },
  };
  const saas = new SaaSSearchToolService(sandbox);
  const context = { userId: "user-a", sessionId: "session-saas-search" };

  const grepResult = await saas.grep({ pattern: "x" }, context);
  assert.equal(grepResult.success, true, grepResult.summary);
  assert.equal(grepResult.content.total_matches, 9);
  assert.equal(grepResult.content.count, 1);
  const match = grepResult.content.matches[0];
  assert.equal(match.line_number, 3, "wire 字段映射 lineNumber → line_number");
  assert.ok(match.line.endsWith(" (line truncated)"));
  assert.ok(Buffer.byteLength(match.line, "utf8") < 2_100);

  const globResult = await saas.glob({ pattern: "*.txt" }, context);
  assert.equal(globResult.success, true, globResult.summary);
  assert.deepEqual(globResult.content.files, ["a.txt", "b.txt"]);
  assert.equal(globResult.content.total_files, 7);
  assert.equal(globResult.content.truncated, true);
});

test("web_fetch converts HTML to markdown with gzip decoding and content filtering", async () => {
  const page = [
    "<html><body>",
    "<h1>Title</h1>",
    "<script>var secret_script = 1;</script>",
    "<p>Hello <strong>world</strong></p>",
    '<div hidden>hidden text</div>',
    '<div style="display:none">invisible text</div>',
    "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    "</body></html>",
  ].join("\n");
  const server = await startHttpServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
    response.end(gzipSync(page));
  });
  try {
    const client = loopbackWebFetchClient();
    const outcome = await client.fetch(`http://127.0.0.1:${server.port}/page`, { timeoutMs: 5000 });
    assert.equal(outcome.statusCode, 200);
    assert.equal(outcome.body.kind, "html");
    assert.ok(outcome.body.content.includes("Hello <strong>world</strong>"), "gzip 应被自动解压");

    const markdown = htmlToMarkdown(outcome.body.content);
    assert.ok(markdown.includes("# Title"));
    assert.ok(markdown.includes("**world**"));
    assert.ok(/\| A\s+\| B\s+\|/.test(markdown) && /\| 1\s+\| 2\s+\|/.test(markdown), "GFM 表格保留");
    assert.equal(markdown.includes("secret_script"), false, "script 内容剔除");
    assert.equal(markdown.includes("hidden text"), false, "hidden 属性剔除");
    assert.equal(markdown.includes("invisible text"), false, "display:none 剔除");

    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-webfetch-md-"));
    try {
      const search = new LocalSearchToolService({ dataRoot, webFetchClient: client });
      const result = await search.webFetch({ url: `http://127.0.0.1:${server.port}/page` });
      assert.equal(result.success, true, result.summary);
      assert.match(result.summary, /HTTP 200/);
      assert.ok(result.content.includes("# Title"));
      assert.equal(result.content.includes("secret_script"), false);
      assert.equal(result.metadata.status_code, 200);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  } finally {
    await stopHttpServer(server);
  }
});

test("web_fetch follows same-origin redirects only, within the hop budget", async () => {
  const other = await startHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("other origin");
  });
  const server = await startHttpServer((request, response) => {
    if (request.url === "/hop") {
      response.writeHead(302, { location: "/target" });
      response.end();
    } else if (request.url === "/cross") {
      response.writeHead(302, { location: `http://127.0.0.1:${other.port}/x` });
      response.end();
    } else if (request.url === "/r1") {
      response.writeHead(302, { location: "/r2" });
      response.end();
    } else if (request.url === "/r2") {
      response.writeHead(302, { location: "/r3" });
      response.end();
    } else if (request.url === "/r3") {
      response.writeHead(302, { location: "/target" });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("final page");
    }
  });
  try {
    const client = loopbackWebFetchClient({ maxRedirects: 2 });

    const followed = await client.fetch(`http://127.0.0.1:${server.port}/hop`, { timeoutMs: 5000 });
    assert.equal(followed.statusCode, 200);
    assert.ok(followed.url.endsWith("/target"), "同源重定向应被跟随");

    await assert.rejects(
      client.fetch(`http://127.0.0.1:${server.port}/cross`, { timeoutMs: 5000 }),
      (error) => error.code === "redirect_blocked" && /跨源/.test(error.message),
      "跨源重定向必须拒绝并指引直接重试",
    );

    await assert.rejects(
      client.fetch(`http://127.0.0.1:${server.port}/r1`, { timeoutMs: 5000 }),
      (error) => error.code === "redirect_blocked" && /重定向超过上限/.test(error.message),
      "重定向跳数超过预算必须拒绝",
    );
  } finally {
    await stopHttpServer(server);
    await stopHttpServer(other);
  }
});

test("web_fetch rejects private destinations before any request is sent", async () => {
  const server = await startHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("internal");
  });
  try {
    assert.equal(isPublicIpAddress("127.0.0.1"), false);
    assert.equal(isPublicIpAddress("10.0.0.1"), false);
    assert.equal(isPublicIpAddress("192.168.1.1"), false);
    assert.equal(isPublicIpAddress("169.254.169.254"), false, "云元数据地址必须拒绝");
    assert.equal(isPublicIpAddress("::1"), false);
    assert.equal(isPublicIpAddress("fc00::1"), false);
    assert.equal(isPublicIpAddress("8.8.8.8"), true);
    assert.equal(isPublicIpAddress("1.1.1.1"), true);

    await assert.rejects(
      resolvePublicAddresses("localhost", new AbortController().signal),
      (error) => error.code === "blocked_url",
      "localhost 解析到回环地址必须整组拒绝",
    );

    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-webfetch-ssrf-"));
    try {
      const search = new LocalSearchToolService({ dataRoot });
      const blocked = await search.webFetch({ url: `http://127.0.0.1:${server.port}/page` });
      assert.equal(blocked.success, false, "默认客户端必须拒绝回环地址");
      assert.match(blocked.summary, /非公网/);
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  } finally {
    await stopHttpServer(server);
  }
});

test("web_fetch decodes declared charsets and honors byte and char caps", async () => {
  const server = await startHttpServer((request, response) => {
    if (request.url === "/latin") {
      response.writeHead(200, { "content-type": "text/plain; charset=iso-8859-1" });
      response.end(Buffer.from([0xe9, 0x74, 0xe9]), "binary");
    } else if (request.url === "/chunked") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("x".repeat(400));
      response.end("x".repeat(400));
    } else if (request.url === "/long") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("y".repeat(3000));
    }
  });
  try {
    const client = loopbackWebFetchClient({ maxResponseBytes: 512 });

    const latin = await client.fetch(`http://127.0.0.1:${server.port}/latin`, { timeoutMs: 5000 });
    assert.equal(latin.body.content, "été", "按声明字符集解码");

    const chunked = await client.fetch(`http://127.0.0.1:${server.port}/chunked`, { timeoutMs: 5000 });
    assert.equal(chunked.truncated, true, "流式超字节上限必须标记截断");
    assert.ok(chunked.body.content.length <= 512);

    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-webfetch-cap-"));
    try {
      const search = new LocalSearchToolService({ dataRoot, webFetchClient: loopbackWebFetchClient() });
      const capped = await search.webFetch({ url: `http://127.0.0.1:${server.port}/long`, maxChars: 1000 });
      assert.equal(capped.success, true, capped.summary);
      assert.equal(capped.metadata.truncated, true);
      assert.ok(capped.content.includes("内容已截断"), "截断说明必须在尾部");
      assert.ok(capped.content.length <= 1000, "含尾部说明的总输出不得超过 max_chars");
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  } finally {
    await stopHttpServer(server);
  }
});

test("markdown conversion is bounded by the nesting-depth guard", () => {
  const deep = `<div>${"<div>".repeat(600)}deep${"</div>".repeat(600)}</div>`;
  assert.equal(htmlToMarkdown(deep), HTML_OMISSION_MARKER, "超深嵌套必须省略而非转换");
  const shallow = `<section>${"<div>".repeat(100)}content${"</div>".repeat(100)}</section>`;
  assert.notEqual(htmlToMarkdown(shallow), HTML_OMISSION_MARKER);
  assert.ok(htmlToMarkdown(shallow).includes("content"));
});

test("web_fetch rejects unsupported targets and surfaces stable error codes", async () => {
  const server = await startHttpServer((request, response) => {
    if (request.url === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0, 1, 2]));
    } else if (request.url === "/badcharset") {
      response.writeHead(200, { "content-type": "text/plain; charset=x-never-exists" });
      response.end("text");
    } else {
      // /hang：不响应，逼出超时路径
      setTimeout(() => response.end("late"), 5000);
    }
  });
  try {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-webfetch-err-"));
    try {
      const search = new LocalSearchToolService({ dataRoot });

      const credentials = await search.webFetch({ url: "http://user:pass@example.com/" });
      assert.equal(credentials.success, false);
      assert.match(credentials.summary, /凭据|invalid_url/);

      const binary = await search.webFetch({ url: `http://8.8.8.8/x`, timeoutMs: 2000 }).catch(() => null);
      if (binary !== null && binary.success === false && /内容类型/.test(binary.summary)) {
        // 公网字面量在多数测试网络可达性不定：仅在拿到响应时断言内容类型拒绝路径。
      }

      const client = loopbackWebFetchClient();
      await assert.rejects(
        client.fetch(`http://127.0.0.1:${server.port}/binary`, { timeoutMs: 5000 }),
        (error) => error.code === "unsupported_content_type",
      );
      await assert.rejects(
        client.fetch(`http://127.0.0.1:${server.port}/badcharset`, { timeoutMs: 5000 }),
        (error) => error.code === "unsupported_content_type" && /字符集/.test(error.message),
      );

      await assert.rejects(
        client.fetch(`http://127.0.0.1:${server.port}/hang`, { timeoutMs: 1000 }),
        (error) => error.code === "timeout" && /超时/.test(error.message),
        "超时必须分类为 timeout 而非 aborted",
      );

      const callerController = new AbortController();
      const pending = client.fetch(`http://127.0.0.1:${server.port}/hang`, { timeoutMs: 10_000, signal: callerController.signal });
      setTimeout(() => callerController.abort(), 150);
      await assert.rejects(
        pending,
        (error) => error.code === "aborted",
        "调用方 AbortSignal 必须中止请求并分类为 aborted",
      );
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  } finally {
    await stopHttpServer(server);
  }
});

test("web_fetch tolerates fake-ip proxy DNS and routes through proxy env", async () => {
  // fake-ip 段（198.18.0.0/15，Clash/sing-box 等 TUN 模式）放行，其余私网段仍拒绝
  const fakeIp = await resolvePublicAddresses(
    "example.com",
    new AbortController().signal,
    async () => [{ address: "198.18.0.12", family: 4 }],
  );
  assert.deepEqual(fakeIp, [{ address: "198.18.0.12", family: 4 }]);
  await assert.rejects(
    resolvePublicAddresses("example.com", new AbortController().signal, async () => [{ address: "192.168.0.12", family: 4 }]),
    (error) => error.code === "blocked_url",
  );

  // HTTP_PROXY 命中：请求以绝对形式 URL 发给代理（源站解析交给代理）；
  // NO_PROXY 命中：回到直连+钉扎路径（origin-form 请求）；回环永远直连。
  let lastRequestUrl = null;
  const proxy = await startHttpServer((request, response) => {
    lastRequestUrl = request.url;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("via proxy");
  });
  // Windows 的 process.env 键名大小写不敏感：http_proxy 与 HTTP_PROXY 是同一条目，
  // 设置其一即可，不得 delete 另一名字（会把刚设置的也删掉）。
  const previousHttpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY;
  const previousNoProxy = process.env.no_proxy ?? process.env.NO_PROXY;
  try {
    process.env.http_proxy = `http://127.0.0.1:${proxy.port}`;

    const client = new WebFetchClient();
    const outcome = await client.fetch("http://example.org/page", { timeoutMs: 5000 });
    assert.equal(outcome.statusCode, 200);
    assert.equal(outcome.body.content, "via proxy");
    assert.equal(lastRequestUrl, "http://example.org/page", "代理请求必须是绝对形式 URL");

    process.env.no_proxy = "example.org";
    const bypassed = new WebFetchClient(DEFAULT_WEB_FETCH_LIMITS, async () => [{ address: "127.0.0.1", family: 4 }]);
    const bypassedOutcome = await bypassed.fetch(`http://sub.example.org:${proxy.port}/x`, { timeoutMs: 5000 });
    assert.equal(bypassedOutcome.statusCode, 200);
    assert.equal(lastRequestUrl, "/x", "NO_PROXY 命中必须走直连（origin-form）");

    delete process.env.no_proxy;
    const loopback = new WebFetchClient(DEFAULT_WEB_FETCH_LIMITS, async () => [{ address: "127.0.0.1", family: 4 }]);
    const direct = await loopback.fetch(`http://127.0.0.1:${proxy.port}/local`, { timeoutMs: 5000 });
    assert.equal(direct.statusCode, 200);
    assert.equal(lastRequestUrl, "/local", "回环永远直连，不进代理");
  } finally {
    if (previousHttpProxy === undefined) delete process.env.http_proxy;
    else process.env.http_proxy = previousHttpProxy;
    if (previousNoProxy === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = previousNoProxy;
    await stopHttpServer(proxy);
  }
});

function loopbackWebFetchClient(overrides = {}) {
  return new WebFetchClient(
    { ...DEFAULT_WEB_FETCH_LIMITS, ...overrides },
    async () => [{ address: "127.0.0.1", family: 4 }],
  );
}

async function startHttpServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

async function stopHttpServer(entry) {
  await new Promise((resolve) => {
    entry.server.closeAllConnections?.();
    entry.server.close(() => resolve());
  });
}

test("system prompt exposes stable execution paths", () => {
  const executionPaths = {
    workspace: "D:/session/workspace",
    uploads: "D:/session/uploads",
  };
  const runtime = createRuntime({
    profile: { agentName: "prompt-test", behavior: { systemPrompt: "" }, llmTiers: {} },
    tools: [],
    execContext: { executionPaths },
  });
  try {
    const first = runtime.preview({ sessionId: "session-prompt", conversation: [] });
    const second = runtime.preview({ sessionId: "session-prompt", conversation: [] });
    assert.equal(first.systemPrompt, second.systemPrompt);
    assert.match(first.systemPrompt, /workspace.*D:\/session\/workspace/s);
    assert.match(first.systemPrompt, /uploads.*D:\/session\/uploads/s);
  } finally {
    runtime.close();
  }
});

test("execute_code uses standard Python and the shared workspace", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-code-modules-"));
  try {
    const service = new CodeExecutionToolService({ dataRoot });
    const context = { sessionId: "session-modules", runId: "run-modules" };
    const result = await service.executeCode({
      code: [
        "import html",
        "import json",
        "import os",
        "from path_ops import SESSION_WORKSPACE_DIR",
        "with open('code-output.txt', 'w', encoding='utf-8') as handle: handle.write('code')",
        "print(json.dumps({'cwd': os.getcwd(), 'escaped': html.escape('<ok>'), 'workspace': os.environ['SESSION_WORKSPACE_DIR'], 'path_ops_workspace': SESSION_WORKSPACE_DIR}, ensure_ascii=False))",
      ].join("\n"),
    }, context);
    assert.equal(result.success, true, result.summary);
    // execute_code 与 execute_shell 一致：返回 stdout 内容，不依赖 result 变量。
    const content = JSON.parse(result.content);
    assert.equal(content.cwd, result.metadata.execution_paths.workspace);
    assert.equal(content.workspace, result.metadata.execution_paths.workspace);
    assert.equal(content.path_ops_workspace, result.metadata.execution_paths.workspace);
    assert.equal(content.escaped, "&lt;ok&gt;");
    assert.equal(fs.readFileSync(path.join(result.metadata.execution_paths.workspace, "code-output.txt"), "utf8"), "code");

    const search = new LocalSearchToolService({ dataRoot });
    const globResult = await search.glob({ pattern: "code-output.txt" }, context);
    assert.deepEqual(globResult.content.files, ["code-output.txt"]);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("execute_code ignores a blank RAGSYSTEM_PYTHON and falls back to PYTHON", async () => {
  const previousRagSystemPython = process.env.RAGSYSTEM_PYTHON;
  const previousPython = process.env.PYTHON;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-code-resolver-"));
  try {
    process.env.RAGSYSTEM_PYTHON = "";
    process.env.PYTHON = "python";
    const service = new CodeExecutionToolService({ dataRoot });
    const result = await service.executeCode(
      { code: "print('python_resolver_ok')" },
      { sessionId: "session-resolver" },
    );
    assert.equal(result.success, true, result.summary);
    assert.match(result.content, /python_resolver_ok/);
  } finally {
    if (previousRagSystemPython === undefined) {
      delete process.env.RAGSYSTEM_PYTHON;
    } else {
      process.env.RAGSYSTEM_PYTHON = previousRagSystemPython;
    }
    if (previousPython === undefined) {
      delete process.env.PYTHON;
    } else {
      process.env.PYTHON = previousPython;
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("execute_shell writes into the same workspace seen by glob", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-bash-workspace-"));
  try {
    const resolver = new ManagedPathResolver(dataRoot);
    const context = { sessionId: "session-bash", runId: "run-bash" };
    const pathPolicy = new PathApprovalService();
    const bash = new LocalBashToolService({ dataRoot, pathResolver: resolver, bashExecutable: null });
    const prepared = bash.prepareExecution(
      { command: `node -e "require('node:fs').writeFileSync('bash-output.txt', 'bash')"` },
      context,
      null,
      pathPolicy,
    );
    assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.result.summary);
    const executed = await bash.executePlan(prepared.plan, context);
    assert.equal(executed.success, true, executed.summary);
    const search = new LocalSearchToolService({ dataRoot, pathResolver: resolver });
    const globResult = await search.glob({ pattern: "bash-output.txt" }, context);
    assert.deepEqual(globResult.content.files, ["bash-output.txt"]);
    assert.equal(fs.readFileSync(path.join(resolver.roots(context).workspace, "bash-output.txt"), "utf8"), "bash");
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("bash syntax downgrades route to approval instead of hard block", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-bash-policy-"));
  try {
    const resolver = new ManagedPathResolver(dataRoot);
    const context = { sessionId: "session-bash-policy", runId: "run-bash-policy" };
    const pathPolicy = new PathApprovalService();
    const bash = new LocalBashToolService({ dataRoot, pathResolver: resolver, bashExecutable: null });

    const redirected = bash.prepareExecution(
      { command: "node -e \"console.log('redir-ok')\" > downgraded.txt" },
      context,
      null,
      pathPolicy,
    );
    assert.equal(redirected.ok, true, redirected.ok ? "" : redirected.result.summary);
    assert.equal(redirected.plan.approvalRequired, true);
    assert.ok(redirected.plan.approvalCommands.includes(">"));
    const executed = await bash.executePlan(redirected.plan, context);
    assert.equal(executed.success, true, executed.summary);
    assert.ok(
      fs.readFileSync(path.join(resolver.roots(context).workspace, "downgraded.txt"), "utf8").includes("redir-ok"),
    );

    const substituted = bash.prepareExecution({ command: "echo $(date)" }, context, null, pathPolicy);
    assert.equal(substituted.ok, true);
    assert.equal(substituted.plan.category, "interpreter");
    assert.ok(substituted.plan.dangerousCommands.includes("$(...)"));

    // cmd 经 /c 只执行首行、其余静默丢弃：多行命令改为分类层直接拒绝并指引用 & 串联。
    // POSIX sh（注入 null bash 在非 win32 的解析结果）原生支持多行，维持放行。
    const multiline = bash.prepareExecution({ command: "ls\npwd" }, context, null, pathPolicy);
    if (process.platform === "win32") {
      assert.equal(multiline.ok, false);
      assert.match(multiline.result.content, /& 串联/);
    } else {
      assert.equal(multiline.ok, true);
    }

    const envOverride = bash.prepareExecution({ command: "PATH=/opt/bin ls" }, context, null, pathPolicy);
    assert.equal(envOverride.ok, true);
    assert.equal(envOverride.plan.approvalRequired, true);
    assert.ok(envOverride.plan.approvalCommands.includes("PATH="));

    const hijack = bash.prepareExecution({ command: "LD_PRELOAD=./evil.so ls" }, context, null, pathPolicy);
    assert.equal(hijack.ok, false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("local and SaaS search adapters share todo validation and result shape", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-search-policy-"));
  try {
    const local = new LocalSearchToolService({ dataRoot });
    const saas = new SaaSSearchToolService(fakeSandboxRuntime());
    const context = { userId: "user-a", sessionId: "session-search" };
    const input = {
      todos: [
        { content: "inspect boundary", status: "in_progress", active_form: "inspecting boundary" },
        { content: "commit refactor", status: "pending" },
      ],
    };

    const localResult = local.todoWrite(input, context);
    const saasResult = saas.todoWrite(input, context);
    assert.deepEqual(saasResult.content, localResult.content);
    assert.equal(saasResult.summary, localResult.summary);
    assert.deepEqual(saasResult.metadata, localResult.metadata);

    const invalid = { todos: [{ content: "invalid", status: "unknown" }] };
    assert.equal(local.todoWrite(invalid, context).success, false);
    assert.equal(saas.todoWrite(invalid, context).success, false);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("SaaS code adapter applies the shared timeout and risk policy", async () => {
  let request = null;
  const service = new SaaSCodeExecutionService({
    async executeCode(_context, input) {
      request = input;
      return { result: 1, stdout: "", stderr: "", returnCode: 0, interrupted: false };
    },
    async releaseRun() {},
    async closeAll() {},
  });

  const result = await service.executeCode({ code: "result = 1", timeout: 999 }, {});
  assert.equal(result.success, true);
  assert.equal(request.timeoutSeconds, 300);
  assert.equal(result.metadata.classification, "read_only");
  assert.equal((await service.executeCode({ code: "  " }, {})).success, false);
});

test("foreground bash abort terminates the shell and its child process tree", async () => {
  const service = new LocalBashToolService({
    dataRoot: process.cwd(),
  });
  const controller = new AbortController();
  const pidFile = `.bash-abort-${randomUUID()}.pid`;
  const plan = {
    command: `node -e "require('node:fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 60000)" | head -20`,
    cwd: process.cwd(),
    timeoutSeconds: 60,
    description: "abort test",
    category: "read_only",
    riskLevel: "low",
    approvalRequired: false,
    approvalCommands: [],
    dangerousCommands: [],
    approvalDescription: "",
    approvalArguments: {},
    metadata: {},
    runInBackground: false,
  };
  const startedAt = Date.now();
  const execution = service.executePlan(plan, {
    signal: controller.signal,
    sessionId: "session-abort-test",
    runId: "run-abort-test",
    taskId: "task-abort-test",
  });
  try {
    await waitFor(() => fs.existsSync(pidFile), 3000, "bash child did not start");
    const childPid = Number(fs.readFileSync(pidFile, "utf8"));
    controller.abort();
    await assert.rejects(execution, (error) => error?.name === "AbortError");
    assert.ok(Date.now() - startedAt < 5000, "foreground bash did not stop promptly");
    await waitFor(() => !isProcessAlive(childPid), 3000, "bash child process survived abort");
  } finally {
    fs.rmSync(pidFile, { force: true });
  }
});

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

function emptyRuntime() {
  return { bash: null, code: null, search: null };
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
    async glob() { return { files: [], truncated: false }; },
    async grep() { return { matches: [], scannedFiles: 0, truncated: false }; },
    async exec() { return { stdout: "", stderr: "", returnCode: 0, interrupted: false }; },
    async executeCode() { return { result: null, stdout: "", stderr: "", returnCode: 0, interrupted: false }; },
    async releaseRun() {},
    async closeAll() {},
  };
}

test("multi-line commands are rejected for cmd and allowed for bash", () => {
  const base = { defaultTimeoutSeconds: 120, maxTimeoutSeconds: 600, backgroundSupported: true };
  const multiline = "echo A\necho B";

  const rejected = classifyBashCommand({ command: multiline }, null, { ...base, multilineSupported: false });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.result.toolName, "execute_shell");
  assert.match(rejected.result.content, /& 串联/, "错误信息须指引用 & 串联单行重试");

  const allowed = classifyBashCommand({ command: multiline }, null, { ...base, multilineSupported: true });
  assert.equal(allowed.ok, true);

  const singleLine = classifyBashCommand({ command: "echo A & echo B" }, null, { ...base, multilineSupported: false });
  assert.equal(singleLine.ok, true, "单行 & 串联命令不受影响");
});

test("local bash service wires the multi-line guard to the resolved shell kind", () => {
  const multiline = { command: "echo A\necho B" };
  const service = new LocalBashToolService({
    dataRoot: os.tmpdir(),
    bashExecutable: "C:\\fake\\bash.exe",
  });
  assert.equal(service.buildCommandClassification(multiline, null).ok, true, "bash 模式支持多行");

  if (process.platform === "win32") {
    const cmdService = new LocalBashToolService({ dataRoot: os.tmpdir(), bashExecutable: null });
    const rejected = cmdService.buildCommandClassification(multiline, null);
    assert.equal(rejected.ok, false, "cmd 模式（无 bash）必须拒绝多行命令");
    assert.match(rejected.result.content, /& 串联/);

    // cmd 语法（\ 非转义）下 `\&` 仍是分隔符：按 cmd 语义拆段，del 触发审批。
    const escapedAmp = cmdService.buildCommandClassification({ command: "echo a\\&del x" }, null);
    assert.equal(escapedAmp.ok, true);
    assert.equal(escapedAmp.classification.approvalRequired, true);
  }
});

test("shell type setting maps to a host shell override", () => {
  const port = (value) => ({ getSection: (_key) => value });
  assert.deepEqual(readHostShellOverride(port({ shell_type: "auto", bash_path: "" })), null);
  assert.deepEqual(readHostShellOverride(port(undefined)), null);
  assert.deepEqual(readHostShellOverride(port({ shell_type: "junk" })), null);
  assert.deepEqual(readHostShellOverride(port(["not", "a", "record"])), null);
  assert.deepEqual(
    readHostShellOverride(port({ shell_type: "bash", bash_path: "C:\\Git\\bin\\bash.exe" })),
    { type: "bash", bashPath: "C:\\Git\\bin\\bash.exe" },
  );
  assert.deepEqual(readHostShellOverride(port({ shell_type: "bash" })), { type: "bash" });
  assert.deepEqual(readHostShellOverride(port({ shell_type: "bash", bash_path: "   " })), { type: "bash" });
  assert.deepEqual(readHostShellOverride(port({ shell_type: "cmd" })), { type: "cmd" });
});

test("local runtime factory registers the shell settings group and wires the lazy override resolver", () => {
  const factory = createLocalExecutionToolsRuntimeFactory();
  // 工厂注册 resolver 之前取自动链基线（可能已被本进程缓存）——dispose 后应回到它。
  const autoBaseline = process.platform === "win32" ? detectHostShell().shellKind : null;
  let extension = null;
  let unregistered = false;
  let section = { shell_type: "cmd" };
  const context = {
    deploymentKind: "local",
    systemConfig: {
      getSection: (key) => (key === "execution_shell" ? section : undefined),
      getToolsConfig: () => ({
        bash_default_timeout: 120,
        bash_max_timeout: 600,
        bash_max_output: 50000,
        code_default_timeout: 60,
        code_max_timeout: 300,
      }),
      registerExtension: (id, ext) => {
        assert.equal(id, EXECUTION_TOOLS_PLUGIN_ID);
        extension = ext;
        return () => { unregistered = true; };
      },
    },
    dataRoot: os.tmpdir(),
  };

  const runtime = factory(context);
  try {
    assert.ok(runtime.bash, "enabled factory must build the bash service");
    assert.equal(extension.groups[0].key, "execution_shell");
    assert.equal(extension.defaults.execution_shell.shell_type, "auto");
    const typeField = extension.groups[0].fields.find((field) => field.key === "shell_type");
    assert.equal(typeField.type, "select");
    assert.deepEqual(
      typeField.options.map((option) => option.value).sort(),
      ["auto", "bash", "cmd"],
    );

    if (process.platform === "win32") {
      assert.equal(detectHostShell().shellKind, "cmd", "cmd 覆盖必须立即生效");
      section = { shell_type: "auto" };
      assert.equal(detectHostShell().shellKind, autoBaseline, "auto 应走自动检测链");
      section = { shell_type: "cmd" };
      assert.equal(detectHostShell().shellKind, "cmd", "设置变更是惰性读取的，无需重建");
    }
  } finally {
    runtime.dispose();
  }
  assert.equal(unregistered, true, "dispose must unregister the settings group");

  if (process.platform === "win32") {
    assert.equal(detectHostShell().shellKind, autoBaseline, "dispose 清除覆盖后回到自动链");
  }
});
