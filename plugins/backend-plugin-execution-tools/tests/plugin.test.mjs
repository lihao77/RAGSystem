import assert from "node:assert/strict";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import {
  createExecutionToolsPlugin,
  createLocalExecutionToolsRuntimeFactory,
} from "../dist/index.js";

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
