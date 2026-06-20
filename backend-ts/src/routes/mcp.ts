import type { FastifyPluginAsync } from "fastify";

import {
  McpRegistryInstallSchema,
  McpServerCreateSchema,
  McpServerPayloadSchema,
} from "../contracts/mcp.js";
import { ok } from "../contracts/common.js";
import { McpServiceError } from "../services/integrations/mcp-service.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface ServerParams {
  serverName: string;
}

interface RegistryQuery {
  search?: string;
  cursor?: string;
  limit?: string | number;
  latest_only?: string;
}

export const registerMcpRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Querystring: RegistryQuery }>("/registry/servers", async (request) => {
    const limit = Number(request.query.limit ?? 8);
    const latestOnly = !["0", "false", "no", "off"].includes(String(request.query.latest_only ?? "true").toLowerCase());
    const result = await options.container.mcp.searchRegistry({
      search: request.query.search,
      cursor: request.query.cursor,
      limit: Number.isFinite(limit) ? limit : 8,
      latestOnly,
    });
    return ok(result, `Found ${result.count} MCP Registry servers`);
  });

  app.post("/registry/install", async (request) => {
    const payload = McpRegistryInstallSchema.parse(request.body);
    try {
      return ok(
        await options.container.mcp.installServerFromRegistry(payload),
        "MCP Server installed from Registry",
      );
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get("/servers", async () => {
    return ok(options.container.mcp.listServers().map(normalizeServerListItem));
  });

  app.post("/servers", async (request) => {
    const rawPayload = isRecord(request.body) ? request.body : {};
    const rawName = String(rawPayload.name ?? "").trim();
    if (!rawName) {
      return ok({ name: "" }, "MCP Server 添加成功");
    }
    const payload = McpServerCreateSchema.parse(request.body);
    try {
      return ok(await options.container.mcp.addServer(payload), "MCP Server 添加成功");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put<{ Params: ServerParams }>("/servers/:serverName", async (request) => {
    const payload = McpServerPayloadSchema.parse(request.body);
    try {
      const status = await options.container.mcp.updateServer(request.params.serverName, payload);
      return ok(normalizeServerStatus(request.params.serverName, status as unknown as Record<string, unknown>), "MCP Server configuration updated and applied");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: ServerParams }>("/servers/:serverName", async (request) => {
    try {
      options.container.mcp.deleteServer(request.params.serverName);
      return ok(undefined, "MCP Server 已删除");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/connect", async (request) => {
    try {
      return ok(await options.container.mcp.connectServer(request.params.serverName), "连接成功");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/disconnect", async (request) => {
    try {
      options.container.mcp.disconnectServer(request.params.serverName, { manual: true });
      return ok(undefined, "已断开连接");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/test", async (request) => {
    try {
      const result = await options.container.mcp.testServer(request.params.serverName);
      return ok(result, result.message);
    } catch (error) {
      if (error instanceof McpServiceError && error.statusCode === 404) {
        throw new HttpError(400, "invalid_request", `MCP Server 配置不存在: ${request.params.serverName}`);
      }
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ServerParams }>("/servers/:serverName/tools", async (request) => {
    try {
      return ok(normalizeToolsResponse(options.container.mcp.listServerTools(request.params.serverName)));
    } catch (error) {
      if (error instanceof McpServiceError && error.statusCode === 404) {
        return ok({ server_name: request.params.serverName, tool_count: 0, tools: [] });
      }
      throw toHttpError(error);
    }
  });

  app.get("/tools", async () => {
    return ok(normalizeToolsResponse(options.container.mcp.listAllTools()));
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeServerListItem(server: Record<string, unknown>): Record<string, unknown> {
  const serverName = String(server.name ?? server.server_name ?? "");
  const normalized = {
    ...server,
    server_name: serverName,
    ...normalizeServerStatus(serverName, server),
  } as Record<string, unknown>;
  delete normalized.tools;
  delete normalized.url;
  return normalized;
}

function normalizeServerStatus(serverName: string, status: Record<string, unknown>): Record<string, unknown> {
  return {
    server_name: serverName,
    status: normalizeMcpStatus(status.status),
    tool_count: status.tool_count ?? 0,
    error_message: typeof status.error_message === "string" ? status.error_message : "",
  };
}

function normalizeMcpStatus(status: unknown): string {
  const value = typeof status === "string" ? status : "";
  return value || "disconnected";
}

function normalizeToolsResponse(response: Record<string, unknown>): Record<string, unknown> {
  const tools = Array.isArray(response.tools) ? response.tools : [];
  return {
    ...response,
    tools: tools.map(normalizeMcpToolDefinition),
  };
}

function normalizeMcpToolDefinition(tool: unknown): Record<string, unknown> {
  if (isRecord(tool) && tool.type === "function" && isRecord(tool.function)) {
    return withPythonMcpToolMetadata(tool);
  }
  const item = isRecord(tool) ? tool : {};
  return withPythonMcpToolMetadata({
    type: "function",
    function: {
      name: item.name ?? "",
      description: item.description ?? "",
      parameters: isRecord(item.parameters) ? item.parameters : { type: "object", properties: {} },
      allowed_callers: ["direct"],
    },
  });
}

const PYTHON_MCP_USAGE_CONTRACT = [
  "先根据 description 和 parameters 判断该 MCP 工具适用场景",
  "返回结构可能不固定，链式传递时优先使用工具返回的 content",
  "若结果是大对象，先读取关键信息再决定是否继续传递给下游工具",
];

const PYTHON_MCP_RETURNS = {
  type: "object",
  description: "返回结构由 MCP Server 定义，可能因工具而异",
  shape: {
    content: "server_defined",
    metadata: "server_defined",
  },
};

function withPythonMcpToolMetadata(tool: Record<string, unknown>): Record<string, unknown> {
  const fn = isRecord(tool.function) ? tool.function : {};
  return {
    type: "function",
    function: {
      ...fn,
      allowed_callers: Array.isArray(fn.allowed_callers) ? fn.allowed_callers : ["direct"],
      source: fn.source ?? "mcp",
      usage_contract: PYTHON_MCP_USAGE_CONTRACT,
      returns: PYTHON_MCP_RETURNS,
    },
  };
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof McpServiceError) {
    return new HttpError(error.statusCode, "invalid_request", error.message);
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}
