import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type {} from "@ragsystem/backend-core/fastify-context.js";

import {
  McpRegistryInstallSchema,
  McpServerCreateSchema,
  McpServerPayloadSchema,
} from "./contracts/mcp.js";
import { AGENT_CONFIG_CHANGED_EVENT } from "@ragsystem/backend-core/contracts/agent/agent-config-events.js";
import { ok } from "@ragsystem/backend-core/contracts/common.js";
import type { BackendPluginEventPublisher } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { McpServiceError } from "./mcp-service.js";
import { HttpError, httpErrorFrom } from "@ragsystem/backend-core/utils/errors.js";
import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import { requireTenantAdmin, requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";
import { MCP_RUNTIME_CAPABILITY } from "./capability.js";

interface ServerParams {
  serverName: string;
}

interface RegistryQuery {
  search?: string;
  cursor?: string;
  limit?: string | number;
  latest_only?: string;
}

interface AgentParams { agentName: string; }
interface TeamQuery { team?: string; }
interface McpRouteOptions { emitPluginEvent?: BackendPluginEventPublisher; }

export const registerMcpRoutes: FastifyPluginAsync<McpRouteOptions> = async (app, options) => {
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
    const result = await resolveMcp(request).searchRegistry({
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
        await resolveMcp(request).installServerFromRegistry(payload),
        "MCP Server installed from Registry",
      );
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get("/servers", async (request) => {
    const servers = await resolveMcp(request).listServers();
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
      return ok(await resolveMcp(request).addServer(payload), "MCP Server 添加成功");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put<{ Params: ServerParams }>("/servers/:serverName", async (request) => {
    const payload = McpServerPayloadSchema.parse(request.body);
    try {
      const status = await resolveMcp(request).updateServer(request.params.serverName, payload);
      return ok(normalizeServerStatus(request.params.serverName, status as unknown as Record<string, unknown>), "MCP Server configuration updated and applied");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: ServerParams }>("/servers/:serverName", async (request) => {
    try {
      await resolveMcp(request).deleteServer(request.params.serverName);
      return ok(undefined, "MCP Server 已删除");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/connect", async (request) => {
    try {
      return ok(await resolveMcp(request).connectServer(request.params.serverName), "连接成功");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/disconnect", async (request) => {
    try {
      await resolveMcp(request).disconnectServer(request.params.serverName);
      return ok(undefined, "已断开连接");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/test", async (request) => {
    try {
      const result = await resolveMcp(request).testServer(request.params.serverName);
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
      return ok(normalizeToolsResponse(await resolveMcp(request).listServerTools(request.params.serverName)));
    } catch (error) {
      if (error instanceof McpServiceError && error.statusCode === 404) {
        return ok({ server_name: request.params.serverName, tool_count: 0, tools: [] });
      }
      throw toHttpError(error);
    }
  });

  app.get("/tools", async (request) => {
    return ok(normalizeToolsResponse(await resolveMcp(request).listAllTools()));
  });

  app.post<{ Params: ServerParams & { toolName: string } }>("/servers/:serverName/tools/:toolName/call", async (request) => {
    const mcp = resolveMcp(request);
    const args = isRecord(request.body) && isRecord(request.body.arguments) ? request.body.arguments : {};
    return ok(await mcp.callTool(request.params.serverName, request.params.toolName, args));
  });

  app.get("/prompts", async (request) => {
    return ok(await resolveMcp(request).listAllPrompts());
  });

  app.get<{ Params: ServerParams }>("/servers/:serverName/metrics", async (request) => {
    try {
      return ok(await resolveMcp(request).getServerMetrics(request.params.serverName));
    } catch (error) {
      if (error instanceof McpServiceError && error.statusCode === 404) {
        return ok({ server_name: request.params.serverName, tools: [] });
      }
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ServerParams }>("/servers/:serverName/resources", async (request) => {
    try {
      return ok(await resolveMcp(request).listServerResources(request.params.serverName));
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
        contents: await resolveMcp(request).readResource(request.params.serverName, uri),
      });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: ServerParams }>("/servers/:serverName/prompts", async (request) => {
    try {
      return ok(await resolveMcp(request).listServerPrompts(request.params.serverName));
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
        messages: await resolveMcp(request).getPrompt(request.params.serverName, name, args),
      });
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: AgentParams; Querystring: TeamQuery }>("/agents/:agentName/config", async (request) => {
    const key = await resolveAgentConfigKey(request, request.params.agentName, request.query.team);
    return ok(await resolveRuntime(request).agentConfig.getEffective(key));
  });

  app.put<{ Params: AgentParams; Querystring: TeamQuery }>("/agents/:agentName/config", async (request) => {
    const key = await resolveAgentConfigKey(request, request.params.agentName, request.query.team);
    const result = await resolveRuntime(request).agentConfig.put(key, request.body);
    await options.emitPluginEvent?.(AGENT_CONFIG_CHANGED_EVENT, {
      tenantId: request.tenantId,
      teamName: key.teamName,
      change: "updated",
    });
    return ok(result);
  });

  app.delete<{ Params: AgentParams; Querystring: TeamQuery }>("/agents/:agentName/config", async (request) => {
    const key = await resolveAgentConfigKey(request, request.params.agentName, request.query.team);
    const result = await resolveRuntime(request).agentConfig.delete(key);
    await options.emitPluginEvent?.(AGENT_CONFIG_CHANGED_EVENT, {
      tenantId: request.tenantId,
      teamName: key.teamName,
      change: "updated",
    });
    return ok(result);
  });
};

export const registerMcpAgentConfigRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (request) => requireTenantMember(request));

  app.get("/mcp-servers", async (request) => {
    const servers = await resolveMcp(request).listServers();
    return ok(servers.map(normalizeAvailableServer), `Found ${servers.length} MCP servers`);
  });
};

function resolveRuntime(request: FastifyRequest) {
  return request.container.pluginCapabilities.require(MCP_RUNTIME_CAPABILITY);
}

function resolveMcp(request: FastifyRequest) {
  return resolveRuntime(request).application;
}

async function resolveAgentConfigKey(
  request: FastifyRequest,
  agentName: string,
  requestedTeam: string | undefined,
): Promise<{ teamName: string; agentName: string }> {
  const teamName = requestedTeam?.trim() || (await request.container.agentConfig.listTeams()).active_team;
  if (!request.container.agentConfig.getConfig(agentName, { teamName })) {
    throw new HttpError(404, "not_found", `智能体 "${agentName}" 在 team "${teamName}" 中不存在`);
  }
  return { teamName, agentName };
}

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

function normalizeAvailableServer(server: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeServerListItem(server);
  return {
    name: normalized.name,
    server_name: normalized.server_name,
    display_name: normalized.display_name,
    transport: normalized.transport,
    enabled: normalized.enabled,
    status: normalized.status,
    tool_count: normalized.tool_count,
    error_message: normalized.error_message,
  };
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
