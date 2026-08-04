import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
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
    resources: [{ kind: "execution-tools.enabled", value: false }],
  });
  assert.deepEqual(local.capabilities.require(EXECUTION_TOOLS_RUNTIME_CAPABILITY), emptyRuntime());
  local.dispose();

  const supplied = { bash: null, code: null, search: { marker: true } };
  const saas = await contributions.createRuntime({
    deploymentKind: "saas",
    resources: [{ kind: "execution-tools.runtime", value: supplied }],
  });
  assert.equal(saas.capabilities.require(EXECUTION_TOOLS_RUNTIME_CAPABILITY), supplied);
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
    resources: [{ kind: "execution-tools.enabled", value: false }],
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

test("managed paths use one alias and isolation policy across execution tools", () => {
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
    fs.mkdirSync(path.join(roots.workspace, "workspace"));
    fs.writeFileSync(path.join(roots.workspace, "root.txt"), "root", "utf8");

    const pathPolicy = new PathApprovalService();
    assert.equal(resolver.resolveWorkingDirectory(null, null, context, pathPolicy), roots.workspace);
    assert.equal(resolver.resolveWorkingDirectory(".", "workspace", context, pathPolicy), roots.workspace);
    assert.equal(resolver.resolveWorkingDirectory("workspace", null, context, pathPolicy), roots.workspace);
    assert.equal(
      resolver.resolveWorkingDirectory("./workspace", null, context, pathPolicy),
      path.join(roots.workspace, "workspace"),
    );
    assert.equal(resolver.resolveWorkingDirectory("transient", null, context, pathPolicy), roots.transient);
    assert.equal(resolver.resolveWorkingDirectory("exports", null, context, pathPolicy), roots.exports);
    assert.throws(
      () => resolver.resolveWorkingDirectory("exports", null, { sessionId: "session-a" }, pathPolicy),
      /缺少 run_id/,
    );

    const bash = new LocalBashToolService({ dataRoot, pathResolver: resolver });
    const bashPlan = bash.prepareExecution({ command: "pwd", workingDir: "workspace" }, context, null, pathPolicy);
    assert.equal(bashPlan.ok, true);
    assert.equal(bashPlan.plan.cwd, roots.workspace);

    const search = new LocalSearchToolService({ dataRoot, pathResolver: resolver });
    const globResult = search.glob({ pattern: "*.txt", path: "workspace" }, context);
    assert.equal(globResult.success, true);
    assert.equal(globResult.metadata.base_path, roots.workspace);
    assert.deepEqual(globResult.content.files, ["root.txt"]);

    const code = new CodeExecutionToolService({ dataRoot, pathResolver: resolver });
    assert.deepEqual(code.getManagedRoots(context), roots);

    const otherSessionRoots = resolver.roots({ sessionId: "session-b", runId: "run-a" });
    const otherRunRoots = resolver.roots({ sessionId: "session-a", runId: "run-b" });
    assert.notEqual(otherSessionRoots.workspace, roots.workspace);
    assert.notEqual(otherSessionRoots.transient, roots.transient);
    assert.notEqual(otherRunRoots.exports, roots.exports);
    assert.equal(otherRunRoots.workspace, roots.workspace);

    assert.deepEqual(resolver.getExternalCandidates(externalRoot, context, pathPolicy), [externalRoot]);
    assert.throws(
      () => resolver.resolveWorkingDirectory(externalRoot, null, context, pathPolicy),
      /超出允许的受管目录范围/,
    );
    pathPolicy.approve([externalRoot]);
    assert.equal(resolver.resolveWorkingDirectory(externalRoot, null, context, pathPolicy), externalRoot);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("execute_code supports approved HTTP modules and a safe os.path shim", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-code-modules-"));
  try {
    const service = new CodeExecutionToolService({ dataRoot });
    const context = { sessionId: "session-modules", runId: "run-modules" };
    const allowed = await service.executeCode({
      code: [
        "import urllib.request",
        "import os",
        "result = {\"url\": urllib.request.Request(\"http://example.com\").full_url, \"name\": os.path.basename(\"a/b.txt\")}",
      ].join("\n"),
    }, context);
    assert.equal(allowed.success, true, allowed.summary);
    assert.deepEqual(allowed.content, { url: "http://example.com", name: "b.txt" });

    const forbidden = await service.executeCode({ code: "from os import system\nresult = 1" }, context);
    assert.equal(forbidden.success, false);
    assert.match(forbidden.summary, /禁止导入模块: os/);
  } finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
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
    artifacts: [],
    llmHint: null,
  };
}
