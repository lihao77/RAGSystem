import type { FastifyPluginAsync } from "fastify";

import {
  McpRegistryInstallSchema,
  McpServerCreateSchema,
  McpServerPayloadSchema,
} from "../contracts/integrations/mcp.js";
import { ok } from "../contracts/common.js";
import { McpServiceError } from "../services/integrations/mcp-service.js";
import { HttpError, httpErrorFrom } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { isRecord } from "../utils/guards.js";
import { requireTenantAdmin, requireTenantMember } from "./tenant-role.js";
import { ensureRequestApplications } from "../app/request-applications.js";

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
  app.addHook("preHandler", async (request) => {
    requireTenantMember(request);
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    const isReadOperation = request.method === "GET"
      || pathname.endsWith("/resources/read")
      || pathname.endsWith("/prompts/get");
    if (!isReadOperation) requireTenantAdmin(request);
  });

  app.get<{ Querystring: RegistryQuery }>("/registry/servers", async (request) => {
    const limit = Number(request.query.limit ?? 8);
    const latestOnly = !["0", "false", "no", "off"].includes(String(request.query.latest_only ?? "true").toLowerCase());
    const result = await (await ensureRequestApplications(request, options)).mcp.searchRegistry({
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
        await (await ensureRequestApplications(request, options)).mcp.installServerFromRegistry(payload),
        "MCP Server installed from Registry",
      );
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get("/servers", async (request) => {
    const servers = await (await ensureRequestApplications(request, options)).mcp.listServers();
    return ok(servers.map((server) => normalizeServerListItem(
      request.identity.role === "member" ? redactServerSecrets(server) : server,
    )));
  });

  app.post("/servers", async (request) => {
    const rawPayload = isRecord(request.body) ? request.body : {};
    const rawName = String(rawPayload.name ?? "").trim();
    if (!rawName) {
      return ok({ name: "" }, "MCP Server 添加成功");
    }
    const payload = McpServerCreateSchema.parse(request.body);
    try {
      return ok(await (await ensureRequestApplications(request, options)).mcp.addServer(payload), "MCP Server 添加成功");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put<{ Params: ServerParams }>("/servers/:serverName", async (request) => {
    const payload = McpServerPayloadSchema.parse(request.body);
    try {
      const status = await (await ensureRequestApplications(request, options)).mcp.updateServer(request.params.serverName, payload);
      return ok(normalizeServerStatus(request.params.serverName, status as unknown as Record<string, unknown>), "MCP Server configuration updated and applied");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: ServerParams }>("/servers/:serverName", async (request) => {
    try {
      await (await ensureRequestApplications(request, options)).mcp.deleteServer(request.params.serverName);
      return ok(undefined, "MCP Server 已删除");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/connect", async (request) => {
    try {
      return ok(await (await ensureRequestApplications(request, options)).mcp.connectServer(request.params.serverName), "连接成功");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/disconnect", async (request) => {
    try {
      await (await ensureRequestApplications(request, options)).mcp.disconnectServer(request.params.serverName);
      return ok(undefined, "已断开连接");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/test", async (request) => {
    try {
      const result = await (await ensureRequestApplications(request, options)).mcp.testServer(request.params.serverName);
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
      return ok(normalizeToolsResponse(await (await ensureRequestApplications(request, options)).mcp.listServerTools(request.params.serverName)));
    } catch (error) {
      if (error instanceof McpServiceError && error.statusCode === 404) {
        return ok({ server_name: request.params.serverName, tool_count: 0, tools: [] });
      }
      throw toHttpError(error);
    }
  });

  app.get("/tools", async (request) => {
    return ok(normalizeToolsResponse(await (await ensureRequestApplications(request, options)).mcp.listAllTools()));
  });

  app.post<{ Params: ServerParams & { toolName: string } }>("/servers/:serverName/tools/:toolName/call", async (request) => {
    const mcp = (await ensureRequestApplications(request, options)).mcp;
    const args = isRecord(request.body) && isRecord(request.body.arguments) ? request.body.arguments : {};
    return ok(await mcp.callTool(request.params.serverName, request.params.toolName, args));
  });

  app.get("/prompts", async (request) => {
    return ok(await (await ensureRequestApplications(request, options)).mcp.listAllPrompts());
  });

  app.get<{ Params: ServerParams }>("/servers/:serverName/metrics", async (request) => {
    try {
      return ok(await (await ensureRequestApplications(request, options)).mcp.getServerMetrics(request.params.serverName));
    } catch (error) {
      if (error instanceof McpServiceError && error.statusCode === 404) {
        return ok({ server_name: request.params.serverName, tools: [] });
      }
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ServerParams }>("/servers/:serverName/resources", async (request) => {
    try {
      return ok(await (await ensureRequestApplications(request, options)).mcp.listServerResources(request.params.serverName));
    } catch (error) {
      if (error instanceof McpServiceError && error.statusCode === 404) {
        return ok({ server_name: request.params.serverName, resource_count: 0, resources: [] });
      }
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/resources/read", async (request) => {
    try {
      const uri = String((isRecord(request.body) ? request.body.uri : "") ?? "");
      if (!uri) {
        throw new HttpError(400, "invalid_request", "uri is required");
      }
      return ok({
        server_name: request.params.serverName,
        uri,
        contents: await (await ensureRequestApplications(request, options)).mcp.readResource(request.params.serverName, uri),
      });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ServerParams }>("/servers/:serverName/prompts", async (request) => {
    try {
      return ok(await (await ensureRequestApplications(request, options)).mcp.listServerPrompts(request.params.serverName));
    } catch (error) {
      if (error instanceof McpServiceError && error.statusCode === 404) {
        return ok({ server_name: request.params.serverName, prompt_count: 0, prompts: [] });
      }
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/prompts/get", async (request) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const name = String(body.name ?? "");
      if (!name) {
        throw new HttpError(400, "invalid_request", "name is required");
      }
      const args = isRecord(body.arguments) ? body.arguments : undefined;
      return ok({
        server_name: request.params.serverName,
        name,
        messages: await (await ensureRequestApplications(request, options)).mcp.getPrompt(request.params.serverName, name, args),
      });
    } catch (error) {
      throw toHttpError(error);
    }
  });
};

function redactServerSecrets<T extends Record<string, unknown>>(server: T): T {
  return {
    ...server,
    env: redactRecordValues(server.env),
    headers: redactRecordValues(server.headers),
  };
}

function redactRecordValues(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.keys(value).map((key) => [key, "********"]));
}

function normalizeServerListItem(server: Record<string, unknown>): Record<string, unknown> {
  const serverName = String(server.name ?? server.server_name ?? "");
  const normalized = {
    ...server,
    server_name: serverName,
    ...normalizeServerStatus(serverName, server),
  } as Record<string, unknown>;
  delete normalized.tools;
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
  // 兼容已是 function 格式的输入(透传);否则从 RuntimeMcpToolDefinition 映射。
  // 自描述(usage_contract/returns/annotations)已在 mcp-service.toRuntimeMcpTool 数据源产出,此处只透传。
  if (isRecord(tool) && tool.type === "function" && isRecord(tool.function)) {
    return tool;
  }
  const item = isRecord(tool) ? tool : {};
  const fn: Record<string, unknown> = {
    name: item.name ?? "",
    description: item.description ?? "",
    parameters: isRecord(item.parameters) ? item.parameters : { type: "object", properties: {} },
    allowed_callers: ["direct"],
    source: typeof item.source === "string" ? item.source : "mcp",
  };
  if (Array.isArray(item.usage_contract)) {
    fn.usage_contract = item.usage_contract;
  }
  if (isRecord(item.returns)) {
    fn.returns = item.returns;
  }
  if (isRecord(item.annotations)) {
    fn.annotations = item.annotations;
  }
  if (typeof item.riskLevel === "string") {
    fn.risk_level = item.riskLevel;
  }
  if (typeof item.original_tool_name === "string") {
    fn.original_tool_name = item.original_tool_name;
  }
  if (typeof item.server_name === "string") {
    fn.server_name = item.server_name;
  }
  return { type: "function", function: fn };
}

function toHttpError(error: unknown): HttpError {
  return httpErrorFrom(error, (e) =>
    e instanceof McpServiceError ? new HttpError(e.statusCode, "invalid_request", e.message) : null,
  );
}
