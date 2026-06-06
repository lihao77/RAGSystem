import type { FastifyPluginAsync } from "fastify";

import { ok } from "../contracts/common.js";
import {
  AgentConfigSchema,
  ApplyPresetRequestSchema,
  CopyAgentsRequestSchema,
  CreateTeamRequestSchema,
  RenameTeamRequestSchema,
} from "../contracts/agent-config.js";
import { HttpError, NotMigratedError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

interface AgentParams {
  agentName: string;
}

interface TeamParams {
  teamName: string;
}

interface ExportQuery {
  format?: string;
}

export const registerAgentConfigRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/configs", async () => {
    const configs = options.container.agentConfig.listConfigs();
    return ok(configs, `共有 ${Object.keys(configs).length} 个智能体配置`);
  });

  app.get<{ Params: AgentParams }>("/configs/:agentName", async (request) => {
    const config = options.container.agentConfig.getConfig(request.params.agentName);
    if (!config) {
      throw new HttpError(404, "not_found", `智能体 "${request.params.agentName}" 不存在`);
    }
    return ok(config, `智能体 "${request.params.agentName}" 配置`);
  });

  app.put<{ Params: AgentParams }>("/configs/:agentName", async (request) => {
    const payload = AgentConfigSchema.parse({
      ...(isRecord(request.body) ? request.body : {}),
      agent_name: request.params.agentName,
    });
    const config = options.container.agentConfig.replaceConfig(request.params.agentName, payload);
    return ok(config, `智能体 "${request.params.agentName}" 配置已更新`);
  });

  app.patch<{ Params: AgentParams }>("/configs/:agentName", async (request) => {
    if (!isRecord(request.body)) {
      throw new HttpError(400, "invalid_request", "请求体必须是对象");
    }
    const config = options.container.agentConfig.patchConfig(request.params.agentName, request.body);
    if (!config) {
      throw new HttpError(404, "not_found", `智能体 "${request.params.agentName}" 不存在`);
    }
    return ok(config, `智能体 "${request.params.agentName}" 配置已更新`);
  });

  app.delete<{ Params: AgentParams }>("/configs/:agentName", async (request) => {
    const deleted = options.container.agentConfig.deleteConfig(request.params.agentName);
    if (!deleted) {
      throw new HttpError(404, "not_found", `智能体 "${request.params.agentName}" 不存在`);
    }
    return ok(undefined, `智能体 "${request.params.agentName}" 配置已删除`);
  });

  app.get<{ Params: AgentParams; Querystring: ExportQuery }>("/configs/:agentName/export", async (request, reply) => {
    const format = normalizeExportFormat(request.query.format);
    const exported = options.container.agentConfig.exportConfig(request.params.agentName, format);
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
      const config = options.container.agentConfig.applyPreset(request.params.agentName, payload.preset);
      if (!config) {
        throw new HttpError(404, "not_found", `智能体 "${request.params.agentName}" 不存在`);
      }
      return ok(config, `智能体 "${request.params.agentName}" 已应用预设 "${payload.preset}"`);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.post<{ Params: AgentParams }>("/configs/:agentName/import", async () => {
    throw new NotMigratedError("Agent config import");
  });

  app.get<{ Params: AgentParams }>("/configs/:agentName/validate", async (request) =>
    ok(
      {
        valid: options.container.agentConfig.getConfig(request.params.agentName) !== null,
        error: options.container.agentConfig.getConfig(request.params.agentName) ? null : "not found",
      },
      "验证完成",
    ),
  );

  app.post("/teams/default/reset", async () =>
    ok(options.container.agentConfig.resetDefaultTeam(), "default team 已重置为系统默认配置"),
  );

  app.get("/teams", async () => ok(options.container.agentConfig.listTeams(), "team 列表"));

  app.post("/teams", async (request) => {
    const payload = CreateTeamRequestSchema.parse(request.body);
    try {
      return ok(options.container.agentConfig.createTeam(payload.team_name, payload.source_team), "team 已创建");
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.post<{ Params: TeamParams }>("/teams/:teamName/activate", async (request) => {
    try {
      return ok(options.container.agentConfig.activateTeam(request.params.teamName), `team "${request.params.teamName}" 已激活`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.delete<{ Params: TeamParams }>("/teams/:teamName", async (request) => {
    try {
      return ok(options.container.agentConfig.deleteTeam(request.params.teamName), `team "${request.params.teamName}" 已删除`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.patch<{ Params: TeamParams }>("/teams/:teamName/rename", async (request) => {
    const payload = RenameTeamRequestSchema.parse(request.body);
    try {
      return ok(options.container.agentConfig.renameTeam(request.params.teamName, payload.new_team_name), `team "${request.params.teamName}" 已重命名`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.post<{ Params: TeamParams }>("/teams/:teamName/copy-agents", async (request) => {
    const payload = CopyAgentsRequestSchema.parse(request.body);
    try {
      return ok(
        options.container.agentConfig.copyAgentsToTeam(request.params.teamName, payload.source_team, payload.agent_names),
        "agents 已复制到目标 team",
      );
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.get("/presets", async () =>
    ok(
      options.container.agentConfig.listPresets(),
      "共有 5 个预设",
    ),
  );

  app.get("/tools", async () => {
    const tools = options.container.agentConfig.listAvailableTools();
    return ok(tools, `共有 ${tools.length} 个工具条目`);
  });

  app.get("/memory-metadata", async () => ok(options.container.agentConfig.getMemoryConfigMetadata(), "Memory 配置元数据"));

  app.get("/mcp-servers", async () => {
    const servers = options.container.agentConfig.listAvailableMcpServers();
    return ok(servers, `Found ${servers.length} MCP servers`);
  });

  app.get("/skills", async () => {
    const skills = options.container.agentConfig.listAvailableSkills();
    return ok(skills, `共有 ${skills.length} 个可用 Skill`);
  });
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
