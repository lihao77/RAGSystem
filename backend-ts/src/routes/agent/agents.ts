import type { FastifyPluginAsync } from "fastify";

import { CreateAgentRequestSchema } from "../../contracts/agent-config.js";
import { ok } from "../../contracts/common.js";
import type { RouteOptions } from "../route-options.js";
import { HttpError } from "../../utils/errors.js";

interface AgentParams {
  agentName: string;
}

export const registerAgentManagementRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/agents", async () => {
    const agents = options.container.agentConfig.listAgents();
    return ok(agents, `共有 ${agents.length} 个智能体`);
  });

  app.post("/agents/create", async (request) => {
    const payload = CreateAgentRequestSchema.parse(request.body);
    try {
      const config = options.container.agentConfig.createAgent(payload);
      return ok(config, `智能体 ${config.agent_name} 创建成功`);
    } catch (error) {
      throw new HttpError(400, "invalid_request", errorMessage(error));
    }
  });

  app.delete<{ Params: AgentParams }>("/agents/delete/:agentName", async (request) => {
    try {
      const deleted = options.container.agentConfig.deleteAgent(request.params.agentName);
      if (!deleted) {
        throw new HttpError(404, "not_found", `智能体 ${request.params.agentName} 不存在`);
      }
      return ok(undefined, `智能体 ${request.params.agentName} 已删除`);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(403, "forbidden", errorMessage(error));
    }
  });

  app.post("/agents/reload", async () =>
    ok(
      {
        runtime: "not_migrated",
        reloaded: false,
      },
      "智能体已重新加载",
    ),
  );
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
