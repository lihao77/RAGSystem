import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { CreateAgentRequestSchema } from "../../contracts/agent/agent-config.js";
import { ok } from "../../contracts/common.js";
import type { RouteOptions } from "../route-options.js";
import { HttpError } from "../../utils/errors.js";
import { ZodError } from "zod";
import { requireTenantAdmin, requireTenantMember } from "../tenant-role.js";
import { AGENT_CONFIG_CHANGED_EVENT } from "../../contracts/agent/agent-config-events.js";

interface AgentParams {
  agentName: string;
}

interface TeamQuery {
  team?: string;
}

function readTeamQuery(query: TeamQuery | undefined): string | null {
  const team = typeof query?.team === "string" ? query.team.trim() : "";
  return team || null;
}

async function emitTeamConfigChange(
  options: RouteOptions,
  request: FastifyRequest,
  teamName: string | null,
): Promise<void> {
  const target = teamName ?? (await request.container.agentConfig.listTeams()).active_team;
  await options.emitPluginEvent?.(AGENT_CONFIG_CHANGED_EVENT, {
    tenantId: request.tenantId,
    teamName: target,
    change: "updated",
  });
}

export const registerAgentManagementRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.post<{ Querystring: TeamQuery }>("/agents/create", async (request) => {
    requireTenantAdmin(request);
    const teamName = readTeamQuery(request.query);
    const payload = parseCreateAgentRequest(request.body);
    try {
      const config = await request.container.agentConfig.createAgent(payload, { teamName });
      await emitTeamConfigChange(options, request, teamName);
      return ok(config, `智能体 ${config.agent_name} 创建成功`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.delete<{ Params: AgentParams; Querystring: TeamQuery }>("/agents/delete/:agentName", async (request) => {
    requireTenantAdmin(request);
    const teamName = readTeamQuery(request.query);
    try {
      const deleted = await request.container.agentConfig.deleteAgent(request.params.agentName, { teamName });
      if (!deleted) {
        throw new HttpError(404, "not_found", `智能体 ${request.params.agentName} 不存在`);
      }
      await emitTeamConfigChange(options, request, teamName);
      return ok(undefined, `智能体 ${request.params.agentName} 已删除`);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(403, "forbidden", errorMessage(error));
    }
  });
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseCreateAgentRequest(body: unknown) {
  try {
    return CreateAgentRequestSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError(
        422,
        "validation_error",
        "请求参数验证失败",
        error.issues.map((issue) => `body -> ${issue.path.join(" -> ") || "body"}: ${issue.message}`),
      );
    }
    throw error;
  }
}
