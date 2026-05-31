import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestApp } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("mcp compatibility routes", () => {
  it("serves empty registry and installed-server state by default", async () => {
    app = await buildTestApp();

    const registry = await app.inject({
      method: "GET",
      url: "/api/mcp/registry/servers?search=filesystem&limit=6&latest_only=true",
    });
    expect(registry.statusCode).toBe(200);
    expect(registry.json()).toMatchObject({
      success: true,
      message: "Found 0 MCP Registry servers",
      data: {
        items: [],
        count: 0,
        next_cursor: null,
        search: "filesystem",
        latest_only: true,
      },
    });

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
        auto_connect: true,
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
        auto_connect: true,
        status: "disconnected",
        tool_count: 0,
        tools: [],
        error_message: null,
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
        status: "disconnected",
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
      url: "https://example.test/mcp",
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

  it("keeps connection and registry install boundaries explicit", async () => {
    app = await buildTestApp();

    await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        name: "remote",
        transport: "sse",
        url: "https://example.test/sse",
      },
    });

    for (const suffix of ["connect", "disconnect", "test"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/mcp/servers/remote/${suffix}`,
        payload: {},
      });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toMatchObject({
        success: false,
        code: "not_migrated",
      });
    }

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
        install_option: { id: "pkg-0", supported: true },
      },
    });
    expect(registryInstall.statusCode).toBe(501);
    expect(registryInstall.json()).toMatchObject({
      success: false,
      code: "not_migrated",
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
    expect(missingTools.statusCode).toBe(404);
    expect(missingTools.json().message).toBe("MCP Server not found: missing");
  });
});
