import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMcpPlugin, McpAgentConfigService, McpService } from "../dist/index.js";

function createServiceWithServers(servers) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-mcp-lazy-"));
  const configPath = path.join(root, "mcp_servers.yaml");
  const entries = {};
  for (const [name, overrides] of Object.entries(servers)) {
    entries[name] = {
      transport: "streamable_http",
      url: "http://127.0.0.1:9/mcp",
      enabled: true,
      auto_connect: false,
      ...overrides,
    };
  }
  // YAML 是 JSON 超集,直接写 JSON 即可被 YAML.parse 读取。
  fs.writeFileSync(configPath, JSON.stringify({ servers: entries }));
  return new McpService({ configPath });
}

function stubConnections(service, { statuses = new Map(), failNames = new Set(), hangNames = new Set() } = {}) {
  const attempts = [];
  service.getServerStatus = (name) => ({
    status: statuses.get(name) ?? "disconnected",
    tool_count: 0,
    tools: [],
    error_message: "",
    resource_count: 0,
    prompt_count: 0,
  });
  service.connectServer = async (name) => {
    attempts.push(name);
    if (hangNames.has(name)) await new Promise(() => {});
    if (failNames.has(name)) throw new Error(`connect failed: ${name}`);
    statuses.set(name, "connected");
    return { status: "connected", tool_count: 0, tools: [], error_message: "", resource_count: 0, prompt_count: 0 };
  };
  return attempts;
}

test("ensureServersReady 只拉起已启用、未连接且未被手动断开的服务器", async () => {
  const service = createServiceWithServers({ alpha: {}, beta: { enabled: false }, gamma: {}, delta: {} });
  service.disconnectServer("gamma", { manual: true });
  const attempts = stubConnections(service, { statuses: new Map([["delta", "connected"]]) });
  await service.ensureServersReady(["alpha", "beta", "gamma", "delta", "missing", "  "]);
  assert.deepEqual(attempts, ["alpha"]);
});

test("连接成功后不重复建连", async () => {
  const service = createServiceWithServers({ alpha: {} });
  const attempts = stubConnections(service);
  await service.ensureServersReady(["alpha"]);
  assert.equal(attempts.length, 1);
  await service.ensureServersReady(["alpha"]);
  assert.equal(attempts.length, 1, "已连接的服务器不再重复建连");
});

test("连接失败进入冷却,冷却期内不重试,冷却期过后重试", async () => {
  const service = createServiceWithServers({ down: {} });
  const attempts = stubConnections(service, { failNames: new Set(["down"]) });
  try {
    await service.ensureServersReady(["down"]);
    assert.equal(attempts.length, 1);
    await service.ensureServersReady(["down"]);
    assert.equal(attempts.length, 1, "默认冷却期内不再重试");
    process.env.MCP_LAZY_CONNECT_RETRY_MS = "1";
    await new Promise((resolve) => setTimeout(resolve, 5));
    await service.ensureServersReady(["down"]);
    assert.equal(attempts.length, 2, "冷却期过后允许重试");
  } finally {
    delete process.env.MCP_LAZY_CONNECT_RETRY_MS;
  }
});

test("不可达服务器按超时放弃且不阻塞后续对话", async () => {
  const service = createServiceWithServers({ hang: {} });
  const attempts = stubConnections(service, { hangNames: new Set(["hang"]) });
  process.env.MCP_LAZY_CONNECT_TIMEOUT_MS = "50";
  try {
    const started = Date.now();
    await service.ensureServersReady(["hang"]);
    assert.ok(Date.now() - started < 2_000, "超时后 ensure 立即返回");
    assert.equal(attempts.length, 1);
    await service.ensureServersReady(["hang"]);
    assert.equal(attempts.length, 1, "超时计为失败,冷却期内不再重试");
  } finally {
    delete process.env.MCP_LAZY_CONNECT_TIMEOUT_MS;
  }
});

test("工具工厂在对话期对 enabled 服务器触发按需建连", async () => {
  const configs = new Map();
  const agentConfig = new McpAgentConfigService({
    get: async (key) => configs.get(`${key.teamName}:${key.agentName}`) ?? null,
    put: async (key, config) => { configs.set(`${key.teamName}:${key.agentName}`, config); },
    delete: async (key) => { configs.delete(`${key.teamName}:${key.agentName}`); },
  });
  await agentConfig.put({ teamName: "blue", agentName: "writer" }, { enabled_servers: ["alpha"] });

  const ensured = [];
  const runtime = {
    service: {
      ensureServersReady: async (names) => { ensured.push([...names]); },
      listRuntimeTools: (enabled) => enabled.includes("alpha") ? [{
        name: "mcp__alpha__echo",
        description: "echo",
        parameters: { type: "object", properties: {} },
        riskLevel: "low",
      }] : [],
    },
    agentConfig,
    ready: Promise.resolve(),
  };

  let toolFactory;
  createMcpPlugin({ runtimeFactory: async () => runtime }).register({
    runtimes: { register: () => {} },
    routes: { register: () => {} },
    tools: { register: (factory) => { toolFactory = factory; } },
  });

  const tools = await toolFactory({
    agent: { agent_name: "writer" },
    teamName: "blue",
    capabilities: { require: () => runtime },
  });
  assert.deepEqual(ensured, [["alpha"]]);
  assert.deepEqual(tools.map((tool) => tool.name), ["mcp__alpha__echo", "read_mcp_resource"]);

  const idle = await toolFactory({
    agent: { agent_name: "reader" },
    teamName: "blue",
    capabilities: { require: () => runtime },
  });
  assert.equal(ensured.length, 1, "enabled_servers 为空时不触发按需建连");
  assert.deepEqual(idle, []);
});
