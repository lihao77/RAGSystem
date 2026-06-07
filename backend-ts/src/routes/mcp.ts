import type { FastifyPluginAsync } from "fastify";

import {
  McpRegistryInstallSchema,
  McpServerCreateSchema,
  McpServerPayloadSchema,
} from "../contracts/mcp.js";
import { ok } from "../contracts/common.js";
import { McpServiceError } from "../services/integrations/mcp-service.js";
import { HttpError, NotMigratedError } from "../utils/errors.js";
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
    const result = options.container.mcp.searchRegistry({
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
      options.container.mcp.validateRegistryInstall(payload);
    } catch (error) {
      throw toHttpError(error);
    }
    throw new NotMigratedError("MCP Registry install");
  });

  app.get("/servers", async () => ok(options.container.mcp.listServers()));

  app.post("/servers", async (request) => {
    const payload = McpServerCreateSchema.parse(request.body);
    try {
      return ok(options.container.mcp.addServer(payload), "MCP Server 添加成功");
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put<{ Params: ServerParams }>("/servers/:serverName", async (request) => {
    const payload = McpServerPayloadSchema.parse(request.body);
    try {
      const status = options.container.mcp.updateServer(request.params.serverName, payload);
      return ok(status, "MCP Server configuration updated and applied");
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
      options.container.mcp.ensureServer(request.params.serverName);
    } catch (error) {
      throw toHttpError(error);
    }
    throw new NotMigratedError("MCP server connection");
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/disconnect", async (request) => {
    try {
      options.container.mcp.ensureServer(request.params.serverName);
    } catch (error) {
      throw toHttpError(error);
    }
    throw new NotMigratedError("MCP server disconnection");
  });

  app.post<{ Params: ServerParams }>("/servers/:serverName/test", async (request) => {
    try {
      options.container.mcp.ensureServer(request.params.serverName);
    } catch (error) {
      throw toHttpError(error);
    }
    throw new NotMigratedError("MCP server test");
  });

  app.get<{ Params: ServerParams }>("/servers/:serverName/tools", async (request) => {
    try {
      return ok(options.container.mcp.listServerTools(request.params.serverName));
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get("/tools", async () => ok(options.container.mcp.listAllTools()));
};

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof McpServiceError) {
    return new HttpError(error.statusCode, "invalid_request", error.message);
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}
