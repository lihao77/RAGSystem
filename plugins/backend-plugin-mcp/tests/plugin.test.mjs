import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import {
  McpAgentConfigService,
  POSTGRES_MCP_MIGRATIONS,
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
  assert.deepEqual(
    createMcpTools({ mcp: service, enabledServers: ["docs"] }).map((tool) => tool.name),
    ["mcp__docs__search", "read_mcp_resource"],
  );
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

test("PostgreSQL MCP migrations own server and agent config tables", () => {
  const sql = POSTGRES_MCP_MIGRATIONS.map((migration) => migration.sql).join("\n");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS saas_mcp_servers/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS mcp_agent_configs/);
  assert.doesNotMatch(sql, /saas_provider_configs/);
});
