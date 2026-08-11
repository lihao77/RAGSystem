import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { ok } from "../contracts/common.js";
import {
  AgentConfigSchema,
  ApplyPresetRequestSchema,
  CopyAgentsRequestSchema,
  CreateTeamRequestSchema,
  RenameTeamRequestSchema,
} from "../contracts/agent/agent-config.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { requireTenantAdmin, requireTenantMember } from "./tenant-role.js";
import { isRecord } from "../utils/guards.js";
import {
  AGENT_CONFIG_CHANGED_EVENT,
  type AgentConfigChangedEvent,
} from "../contracts/agent/agent-config-events.js";

interface AgentParams {
  agentName: string;
}

interface TeamParams {
  teamName: string;
}

interface ExportQuery {
  format?: string;
}

interface ImportQuery {
  format?: string;
}

interface TeamQuery {
  team?: string;
}

function readTeamQuery(query: TeamQuery | undefined): string | null {
  const team = typeof query?.team === "string" ? query.team.trim() : "";
  return team || null;
}

export const registerAgentConfigRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => {
    requireTenantMember(request);
    if (request.method !== "GET") requireTenantAdmin(request);
  });

  app.get<{ Querystring: TeamQuery }>("/configs", async (request) => {
    const teamName = readTeamQuery(request.query);
    const configs = request.container.agentConfig.listConfigs({ teamName });
    return ok(configs, `共有 ${Object.keys(configs).length} 个智能体配置`);
  });

  app.get<{ Params: AgentParams; Querystring: TeamQuery }>("/configs/:agentName", async (request) => {
    const teamName = readTeamQuery(request.query);
    const config = request.container.agentConfig.getConfig(request.params.agentName, { teamName });
    if (!config) {
      throw new HttpError(404, "not_found", `智能体 "${request.params.agentName}" 不存在`);
    }
    return ok(config, `智能体 "${request.params.agentName}" 配置`);
  });

  app.put<{ Params: AgentParams; Querystring: TeamQuery }>("/configs/:agentName", async (request) => {
    const teamName = readTeamQuery(request.query);
    const payload = AgentConfigSchema.parse({
      ...(isRecord(request.body) ? request.body : {}),
      agent_name: request.params.agentName,
    });
    const config = await request.container.agentConfig.replaceConfig(request.params.agentName, payload, { teamName });
    await emitConfigWriteChange(options, request, teamName);
    return ok(config, `智能体 "${request.params.agentName}" 配置已更新`);
  });

  app.patch<{ Params: AgentParams; Querystring: TeamQuery }>("/configs/:agentName", async (request) => {
    if (!isRecord(request.body)) {
      throw new HttpError(400, "invalid_request", "请求体必须是对象");
    }
    const teamName = readTeamQuery(request.query);
    const config = await request.container.agentConfig.patchConfig(request.params.agentName, request.body, { teamName });
    if (!config) {
      throw new HttpError(404, "not_found", `智能体 "${request.params.agentName}" 不存在`);
    }
    await emitConfigWriteChange(options, request, teamName);
    return ok(config, `智能体 "${request.params.agentName}" 配置已更新`);
  });

  app.delete<{ Params: AgentParams; Querystring: TeamQuery }>("/configs/:agentName", async (request) => {
    const teamName = readTeamQuery(request.query);
    const deleted = await request.container.agentConfig.deleteConfig(request.params.agentName, { teamName });
    if (!deleted) {
      throw new HttpError(404, "not_found", `智能体 "${request.params.agentName}" 不存在`);
    }
    await emitConfigWriteChange(options, request, teamName);
    return ok(undefined, `智能体 "${request.params.agentName}" 配置已删除`);
  });

  app.get<{ Params: AgentParams; Querystring: ExportQuery }>("/configs/:agentName/export", async (request, reply) => {
    const format = normalizeExportFormat(request.query.format);
    const exported = request.container.agentConfig.exportConfig(request.params.agentName, format);
    if (!exported) {
      throw new HttpError(404, "not_found", `智能体 "${request.params.agentName}" 不存在`);
    }
    reply
      .type(exported.contentType)
      .header("content-disposition", `attachment; filename="${request.params.agentName}.${exported.fileExtension}"`);
    return exported.content;
  });

  app.post<{ Params: AgentParams }>("/configs/:agentName/preset", async (request) => {
    const payload = ApplyPresetRequestSchema.parse(request.body);
    try {
      if (!Object.prototype.hasOwnProperty.call(request.container.agentConfig.listPresets(), payload.preset)) {
        throw new HttpError(400, "invalid_request", `无效的预设名称: ${payload.preset}`);
      }
      const config = await request.container.agentConfig.applyPreset(request.params.agentName, payload.preset);
      if (!config) {
        throw new HttpError(404, "not_found", `智能体 "${request.params.agentName}" 不存在`);
      }
      await emitActiveTeamChange(options, request);
      return ok(config, `智能体 "${request.params.agentName}" 已应用预设 "${payload.preset}"`);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.post<{ Params: AgentParams; Querystring: ImportQuery }>("/configs/:agentName/import", async (request) => {
    try {
      const importOptions: { formatName?: string | null; contentType?: string } = {};
      if (request.query.format !== undefined) {
        importOptions.formatName = request.query.format;
      }
      if (request.headers["content-type"] !== undefined) {
        importOptions.contentType = request.headers["content-type"];
      }
      const config = await request.container.agentConfig.importConfig(request.body, {
        ...importOptions,
      });
      await emitActiveTeamChange(options, request);
      return ok(config, `智能体 "${config.agent_name}" 配置已导入`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.get<{ Params: AgentParams }>("/configs/:agentName/validate", async (request) =>
    ok(
      {
        valid: request.container.agentConfig.getConfig(request.params.agentName) !== null,
        error: request.container.agentConfig.getConfig(request.params.agentName) ? null : "not found",
      },
      "验证完成",
    ),
  );

  app.post("/teams/default/reset", async (request) => {
    const result = await request.container.agentConfig.resetDefaultTeam();
    await emitAgentConfigChanged(options, request, { teamName: "default" });
    return ok(result, "default team 已重置为系统默认配置");
  });

  app.get("/teams", async (request) => ok(await request.container.agentConfig.listTeams(), "team 列表"));

  app.post("/teams", async (request) => {
    const payload = CreateTeamRequestSchema.parse(request.body);
    try {
      const result = await request.container.agentConfig.createTeam(payload.team_name, payload.source_team);
      await emitAgentConfigChanged(options, request, { teamName: payload.team_name });
      return ok(result, "team 已创建");
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.post<{ Params: TeamParams }>("/teams/:teamName/activate", async (request) => {
    try {
      return ok(await request.container.agentConfig.activateTeam(request.params.teamName), `team "${request.params.teamName}" 已激活`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.delete<{ Params: TeamParams }>("/teams/:teamName", async (request) => {
    try {
      const result = await request.container.agentConfig.deleteTeam(request.params.teamName);
      await options.emitPluginEvent?.(AGENT_CONFIG_CHANGED_EVENT, {
        tenantId: request.tenantId,
        teamName: request.params.teamName,
        change: "deleted",
      } satisfies AgentConfigChangedEvent);
      return ok(result, `team "${request.params.teamName}" 已删除`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.patch<{ Params: TeamParams }>("/teams/:teamName/rename", async (request) => {
    const payload = RenameTeamRequestSchema.parse(request.body);
    try {
      const result = await request.container.agentConfig.renameTeam(request.params.teamName, payload.new_team_name);
      await emitAgentConfigChanged(options, request, {
        teamName: payload.new_team_name,
        previousTeamName: request.params.teamName,
      });
      return ok(result, `team "${request.params.teamName}" 已重命名`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.post<{ Params: TeamParams }>("/teams/:teamName/copy-agents", async (request) => {
    const payload = CopyAgentsRequestSchema.parse(request.body);
    try {
      const result = await request.container.agentConfig.copyAgentsToTeam(
        request.params.teamName,
        payload.source_team,
        payload.agent_names,
      );
      await emitAgentConfigChanged(options, request, { teamName: request.params.teamName });
      return ok(result, "agents 已复制到目标 team");
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.get("/presets", async (request) =>
    ok(
      request.container.agentConfig.listPresets(),
      "共有 5 个预设",
    ),
  );

  app.get("/tools", async (request) => {
    const tools = [
      ...request.container.agentConfig.listAvailableTools(),
      ...request.container.listPluginTools(),
    ].map(normalizeAvailableTool);
    return ok(tools, `共有 ${tools.length} 个可用工具`);
  });

};

/** 配置写操作后按目标 team 发变更事件：显式 team 用其自身，否则回退当前激活 team。 */
async function emitConfigWriteChange(options: RouteOptions, request: FastifyRequest, teamName: string | null): Promise<void> {
  if (teamName) {
    await emitAgentConfigChanged(options, request, { teamName });
    return;
  }
  await emitActiveTeamChange(options, request);
}

async function emitActiveTeamChange(options: RouteOptions, request: FastifyRequest): Promise<void> {
  const { active_team: activeTeam } = await request.container.agentConfig.listTeams();
  await emitAgentConfigChanged(options, request, { teamName: activeTeam });
}

async function emitAgentConfigChanged(
  options: RouteOptions,
  request: FastifyRequest,
  change: Omit<AgentConfigChangedEvent, "tenantId" | "change">,
): Promise<void> {
  await options.emitPluginEvent?.(AGENT_CONFIG_CHANGED_EVENT, {
    tenantId: request.tenantId,
    change: "updated",
    ...change,
  } satisfies AgentConfigChangedEvent);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeExportFormat(format: string | undefined): "json" | "yaml" {
  if (format === undefined || format === "" || format === "yaml" || format === "yml") {
    return "yaml";
  }
  if (format === "json") {
    return "json";
  }
  throw new HttpError(400, "invalid_request", "format 只支持 json 或 yaml");
}

function normalizeAvailableTool(tool: unknown): Record<string, unknown> {
  const item = isRecord(tool) ? tool : {};
  const name = String(item.name ?? "");
  return {
    name,
    display_name: displayNameFromToolName(name),
    description: typeof item.description === "string" ? item.description : "",
    category: typeof item.category === "string" ? item.category : "",
    source: "decorator",
    risk_level: typeof item.risk_level === "string" ? item.risk_level : "low",
  };
}

function displayNameFromToolName(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
