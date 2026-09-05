import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("managed paths share one deterministic workspace view across execution tools", () => {
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
    const globResult = search.glob({ pattern: "*.txt" }, context);
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

test("glob and grep apply read-path approval outside managed roots", () => {
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
    const rejected = search.glob({ pattern: "*.txt", path: externalRoot }, context, pathPolicy);
    assert.equal(rejected.success, false);
    assert.match(rejected.summary, /受管目录范围/);

    pathPolicy.approve([externalRoot]);
    const globResult = search.glob({ pattern: "*.txt", path: externalRoot }, context, pathPolicy);
    assert.equal(globResult.success, true);
    assert.deepEqual(globResult.content.files, ["needle.txt"]);
    const grepResult = search.grep({ pattern: "needle", path: externalRoot }, context, pathPolicy);
    assert.equal(grepResult.success, true);
    assert.equal(grepResult.content.matches.length, 1);

    // 已批准后不再产生候选信号
    assert.deepEqual(search.getSearchRootCandidates(externalRoot, context, pathPolicy), []);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

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
    const globResult = search.glob({ pattern: "code-output.txt" }, context);
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
    const globResult = search.glob({ pattern: "bash-output.txt" }, context);
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
