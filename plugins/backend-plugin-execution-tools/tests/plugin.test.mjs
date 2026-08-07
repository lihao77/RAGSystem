import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRuntime } from "@ragsystem/agent-sdk";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { PathApprovalService } from "@ragsystem/backend-core/services/runtime/path-approval-service.js";
import {
  backendPluginModule,
  CodeExecutionToolService,
  createExecutionToolsPlugin,
  createLocalExecutionToolsRuntimeFactory,
  EXECUTION_TOOLS_RUNTIME_CAPABILITY,
  ManagedPathResolver,
} from "../dist/index.js";
import { LocalBashToolService } from "../dist/tools/BashTool/BashExecution.js";
import { LocalSearchToolService } from "../dist/tools/LocalSearchTools/SearchExecution.js";
import { SaaSCodeExecutionService, SaaSSearchToolService } from "../dist/storage/saas/sandbox-execution-tools.js";

const descriptors = [
  "glob",
  "grep",
  "web_fetch",
  "todo_write",
  "execute_bash",
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
        "import os",
        "from path_ops import SESSION_WORKSPACE_DIR",
        "with open('code-output.txt', 'w', encoding='utf-8') as handle: handle.write('code')",
        "result = {\"cwd\": os.getcwd(), \"escaped\": html.escape('<ok>'), \"workspace\": os.environ['SESSION_WORKSPACE_DIR'], \"path_ops_workspace\": SESSION_WORKSPACE_DIR}",
      ].join("\n"),
    }, context);
    assert.equal(result.success, true, result.summary);
    assert.equal(result.content.cwd, result.metadata.execution_paths.workspace);
    assert.equal(result.content.workspace, result.metadata.execution_paths.workspace);
    assert.equal(result.content.path_ops_workspace, result.metadata.execution_paths.workspace);
    assert.equal(result.content.escaped, "&lt;ok&gt;");
    assert.equal(fs.readFileSync(path.join(result.metadata.execution_paths.workspace, "code-output.txt"), "utf8"), "code");

    const search = new LocalSearchToolService({ dataRoot });
    const globResult = search.glob({ pattern: "code-output.txt" }, context);
    assert.deepEqual(globResult.content.files, ["code-output.txt"]);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

test("execute_bash writes into the same workspace seen by glob", async () => {
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
