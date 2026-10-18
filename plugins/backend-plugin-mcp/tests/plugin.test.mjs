import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { listAgentCapabilityProviders } from "@ragsystem/backend-core/plugins/agent-capability-provider.js";
import {
  McpAgentConfigService,
  SqliteMcpAgentConfigStore,
  createMcpPlugin,
  createMcpTools,
} from "../dist/index.js";

test("MCP routes are contributed only when the plugin is installed", async () => {
  const empty = new BackendPluginManager();
  await empty.register();
  assert.deepEqual(empty.routes("tenant"), []);

  const installed = new BackendPluginManager([
    createMcpPlugin({ runtimeFactory: () => { throw new Error("not used"); } }),
  ]);
  await installed.register();
  assert.deepEqual(installed.routes("tenant").map((route) => route.prefix), [
    "/api/mcp",
    "/api/agent-config",
  ]);
});

test("agent MCP config is isolated and delete restores defaults", async () => {
  const values = new Map();
  const keyOf = ({ teamName, agentName }) => `${teamName}:${agentName}`;
  const service = new McpAgentConfigService({
    get: async (key) => values.get(keyOf(key)) ?? null,
    put: async (key, config) => { values.set(keyOf(key), config); },
    delete: async (key) => values.delete(keyOf(key)),
  });

  await service.put({ teamName: "blue", agentName: "planner" }, { enabled_servers: ["docs"] });
  assert.deepEqual(await service.getEffective({ teamName: "blue", agentName: "planner" }), {
    enabled_servers: ["docs"],
  });
  assert.deepEqual(await service.getEffective({ teamName: "red", agentName: "planner" }), {
    enabled_servers: [],
  });
  assert.deepEqual(await service.delete({ teamName: "blue", agentName: "planner" }), {
    enabled_servers: [],
  });
});

test("MCP tool visibility follows enabled server config", () => {
  const service = {
    listRuntimeTools: (enabled) => enabled.includes("docs") ? [{
      name: "mcp__docs__search",
      description: "search docs",
      parameters: { type: "object", properties: {} },
      riskLevel: "low",
    }] : [],
    callRuntimeTool: async () => ({ success: true }),
    readResource: async () => [],
  };
  assert.deepEqual(createMcpTools({ mcp: service, enabledServers: [] }), []);
  const tools = createMcpTools({ mcp: service, enabledServers: ["docs"] });
  assert.deepEqual(tools.map((tool) => tool.name), ["mcp__docs__search", "read_mcp_resource"]);
  // 调用方准入:server 工具与 read_mcp_resource 都允许 execute_code 沙箱经 call_tool 调用
  for (const tool of tools) {
    assert.deepEqual(tool.allowedCallers, ["direct", "code_execution"]);
  }
});

test("MCP agent capability provider exposes connected tool names and live inventory detail", async () => {
  const searchTool = {
    name: "mcp__docs__search",
    description: "search docs",
    riskLevel: "low",
    server_name: "docs",
    annotations: { readOnlyHint: true },
  };
  const service = {
    listServers: () => [
      { name: "docs", display_name: "Docs", enabled: true, transport: "stdio" },
      { name: "offline", display_name: "Offline", enabled: true, transport: "stdio" },
    ],
    listAllTools: () => ({ tool_count: 1, tools: [searchTool] }),
    ensureServersReady: async () => undefined,
    getServerStatus: (name) => (name === "docs"
      ? { status: "connected", error_message: null }
      : { status: "error", error_message: "unreachable" }),
    listServerTools: (name) => ({
      server_name: name,
      tool_count: name === "docs" ? 1 : 0,
      tools: name === "docs" ? [searchTool] : [],
    }),
  };
  const manager = new BackendPluginManager([
    createMcpPlugin({
      runtimeFactory: async () => ({
        service,
        agentConfig: {
          getEffective: async () => ({ enabled_servers: [] }),
          put: async () => undefined,
        },
        ready: Promise.resolve(),
      }),
    }),
  ]);
  await manager.register();
  const runtime = await manager.runtimeContributions().createRuntime({ deploymentKind: "local", tenantId: "tenant-test" });
  const provider = listAgentCapabilityProviders(runtime.capabilities).find((item) => item.id === "mcp");
  assert.ok(provider);

  // 清单：已连接服务器的工具名透出，未连接的为空数组
  const items = provider.listItems();
  assert.deepEqual(items.find((item) => item.name === "docs").metadata, { tool_names: ["mcp__docs__search"] });
  assert.deepEqual(items.find((item) => item.name === "offline").metadata, { tool_names: [] });

  // 下钻：连接状态 + 工具目录（名称/描述/只读标记/风险级）
  const detail = await provider.getItemDetail("docs");
  assert.equal(detail.name, "docs");
  assert.equal(detail.detail.connection_status, "connected");
  assert.deepEqual(detail.detail.tools, [
    { name: "mcp__docs__search", description: "search docs", read_only: true, risk_level: "low" },
  ]);

  const offline = await provider.getItemDetail("offline");
  assert.equal(offline.detail.connection_status, "error");
  assert.equal(offline.detail.connection_error, "unreachable");
  assert.deepEqual(offline.detail.tools, []);
  assert.match(offline.detail.note, /没有可见工具/);

  assert.equal(await provider.getItemDetail("missing"), null);
});

test("SQLite MCP config store persists tenant-scoped overrides", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-mcp-test-"));
  const dbPath = path.join(root, "mcp.db");
  try {
    let db = new DatabaseSync(dbPath);
    let store = new SqliteMcpAgentConfigStore(db, "tenant-a");
    await store.put({ teamName: "default", agentName: "writer" }, { enabled_servers: ["docs"] });
    db.close();

    db = new DatabaseSync(dbPath);
    store = new SqliteMcpAgentConfigStore(db, "tenant-a");
    assert.deepEqual(await store.get({ teamName: "default", agentName: "writer" }), {
      enabled_servers: ["docs"],
    });
    assert.equal(await new SqliteMcpAgentConfigStore(db, "tenant-b").get({
      teamName: "default",
      agentName: "writer",
    }), null);
    db.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
