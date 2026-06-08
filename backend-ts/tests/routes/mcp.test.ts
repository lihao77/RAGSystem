import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;
const tempRoots: string[] = [];

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("mcp compatibility routes", () => {
  it("serves installed-server state by default", async () => {
    app = await buildTestApp();

    const servers = await app.inject({
      method: "GET",
      url: "/api/mcp/servers",
    });
    expect(servers.statusCode).toBe(200);
    expect(servers.json()).toMatchObject({
      success: true,
      data: [],
    });

    const tools = await app.inject({
      method: "GET",
      url: "/api/mcp/tools",
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toMatchObject({
      data: {
        tool_count: 0,
        tools: [],
      },
    });
  });

  it("supports in-memory server add, update, tools, and delete", async () => {
    app = await buildTestApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        name: "filesystem",
        display_name: "Filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        env: { ROOT: "E:/Python/RAGSystem" },
        enabled: true,
        auto_connect: false,
        timeout: 30,
        risk_level: "medium",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      success: true,
      message: "MCP Server 添加成功",
      data: {
        name: "filesystem",
      },
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/mcp/servers",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data).toMatchObject([
      {
        name: "filesystem",
        display_name: "Filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        enabled: true,
        auto_connect: false,
        status: "not_loaded",
        tool_count: 0,
        error_message: "",
      },
    ]);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/mcp/servers/filesystem",
      payload: {
        display_name: "Filesystem Local",
        transport: "streamable_http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer token" },
        enabled: false,
        auto_connect: false,
        timeout: 60,
        risk_level: "high",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      success: true,
      data: {
        status: "not_loaded",
        tool_count: 0,
      },
    });

    const tools = await app.inject({
      method: "GET",
      url: "/api/mcp/servers/filesystem/tools",
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toMatchObject({
      data: {
        server_name: "filesystem",
        tool_count: 0,
        tools: [],
      },
    });

    const afterUpdate = await app.inject({
      method: "GET",
      url: "/api/mcp/servers",
    });
    expect(afterUpdate.json().data[0]).toMatchObject({
      name: "filesystem",
      display_name: "Filesystem Local",
      transport: "streamable_http",
      headers: { Authorization: "Bearer token" },
      enabled: false,
      auto_connect: false,
      timeout: 60,
      risk_level: "high",
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/mcp/servers/filesystem",
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      success: true,
      message: "MCP Server 已删除",
    });
  });

  it("connects to a stdio MCP server, lists tools, tests, and disconnects", async () => {
    app = await buildTestApp();
    const serverScript = writeMockMcpServer();

    const created = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        name: "mock",
        display_name: "Mock MCP",
        transport: "stdio",
        command: process.execPath,
        args: [serverScript],
        timeout: 5,
      },
    });
    expect(created.statusCode).toBe(200);

    const connected = await app.inject({
      method: "POST",
      url: "/api/mcp/servers/mock/connect",
      payload: {},
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json().data).toMatchObject({
      status: "connected",
      tool_count: 1,
      tools: [
        {
          name: "mcp__mock__echo",
          server_name: "mock",
          original_tool_name: "echo",
        },
      ],
    });

    const tools = await app.inject({
      method: "GET",
      url: "/api/mcp/servers/mock/tools",
    });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().data).toMatchObject({
      server_name: "mock",
      tool_count: 1,
      tools: [
        {
          type: "function",
          function: {
            name: "mcp__mock__echo",
            source: "mcp",
            parameters: {
              type: "object",
            },
          },
        },
      ],
    });

    const tested = await app.inject({
      method: "POST",
      url: "/api/mcp/servers/mock/test",
      payload: {},
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().data).toMatchObject({
      success: true,
      tool_count: 1,
    });

    const disconnected = await app.inject({
      method: "POST",
      url: "/api/mcp/servers/mock/disconnect",
      payload: {},
    });
    expect(disconnected.statusCode).toBe(200);
    expect(disconnected.json()).toEqual({
      success: true,
      message: "已断开连接",
    });

    const afterDisconnect = await app.inject({
      method: "GET",
      url: "/api/mcp/servers/mock/tools",
    });
    expect(afterDisconnect.json().data.tool_count).toBe(0);

    const serversAfterDisconnect = await app.inject({
      method: "GET",
      url: "/api/mcp/servers",
    });
    expect(serversAfterDisconnect.json().data[0]).toMatchObject({
      name: "mock",
      status: "disconnected",
      tool_count: 0,
    });

    const allToolsAfterDisconnect = await app.inject({
      method: "GET",
      url: "/api/mcp/tools",
    });
    expect(allToolsAfterDisconnect.json().data).toMatchObject({
      tool_count: 0,
      tools: [],
    });
  });

  it("keeps manual disconnect when an automatic connect finishes later", async () => {
    app = await buildTestApp();
    const serverScript = writeMockMcpServer({ initializeDelayMs: 120 });

    const created = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        name: "slow",
        display_name: "Slow MCP",
        transport: "stdio",
        command: process.execPath,
        args: [serverScript],
        timeout: 5,
      },
    });
    expect(created.statusCode).toBe(200);

    const disconnected = await app.inject({
      method: "POST",
      url: "/api/mcp/servers/slow/disconnect",
      payload: {},
    });
    expect(disconnected.statusCode).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const servers = await app.inject({
      method: "GET",
      url: "/api/mcp/servers",
    });
    expect(servers.json().data[0]).toMatchObject({
      name: "slow",
      status: "disconnected",
      tool_count: 0,
    });

    const tools = await app.inject({
      method: "GET",
      url: "/api/mcp/tools",
    });
    expect(tools.json().data).toMatchObject({
      tool_count: 0,
      tools: [],
    });
  });

  it("installs supported registry package options as server configs", async () => {
    app = await buildTestApp();

    const registryMissingPayload = await app.inject({
      method: "POST",
      url: "/api/mcp/registry/install",
      payload: {},
    });
    expect(registryMissingPayload.statusCode).toBe(400);
    expect(registryMissingPayload.json().message).toBe("`install_option` is required");

    const registryInstall = await app.inject({
      method: "POST",
      url: "/api/mcp/registry/install",
      payload: {
        install_option: {
          id: "pkg-0",
          kind: "package",
          supported: true,
          default_server_name: "Mock Package",
          default_display_name: "Mock Package",
          recipe: {
            registryType: "npm",
            identifier: "@example/mcp-server",
            version: "1.2.3",
            transport: { type: "stdio" },
          },
        },
        auto_connect: false,
      },
    });
    expect(registryInstall.statusCode).toBe(200);
    expect(registryInstall.json()).toMatchObject({
      success: true,
      message: "MCP Server installed from Registry",
      data: {
        name: "mock_package",
        command: "npx",
        args: ["-y", "@example/mcp-server@1.2.3"],
        status: "not_loaded",
      },
    });
  });

  it("validates server configuration and missing resources", async () => {
    app = await buildTestApp();

    const invalidStdio = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        name: "bad",
        transport: "stdio",
      },
    });
    expect(invalidStdio.statusCode).toBe(400);
    expect(invalidStdio.json().message).toBe("stdio MCP Server 必须填写 command");

    const missingTools = await app.inject({
      method: "GET",
      url: "/api/mcp/servers/missing/tools",
    });
    expect(missingTools.statusCode).toBe(200);
    expect(missingTools.json()).toMatchObject({
      success: true,
      data: {
        server_name: "missing",
        tool_count: 0,
        tools: [],
      },
    });
  });
});

function writeMockMcpServer(options: { initializeDelayMs?: number } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-mcp-"));
  tempRoots.push(root);
  const script = path.join(root, "mock-mcp-server.cjs");
  fs.writeFileSync(script, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const initializeDelayMs = ${JSON.stringify(options.initializeDelayMs ?? 0)};
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1.0.0" } } }), initializeDelayMs);
    return;
  }
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] } });
    return;
  }
  if (message.method === "tools/call") {
    const text = message.params && message.params.arguments ? message.params.arguments.text : "";
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo:" + text }], isError: false } });
  }
});
`, "utf8");
  return script;
}
