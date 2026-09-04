import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import type { RouteOptions } from "../route-options.js";

interface RuntimeCoreStatusQuery {
  agent_name?: string;
  team_name?: string;
  selected_llm?: string;
}

export const registerRuntimeCoreRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Querystring: RuntimeCoreStatusQuery }>("/runtime-core/status", async (request) => {
    const selectedLlm = request.query.selected_llm ?? null;
    return ok(
      request.container.runtimeCore.getReadiness({
        agentName: request.query.agent_name ?? null,
        // 前端新建会话可能带团队上下文（composer 的当前团队）；与执行路径同源，
        // 按团队解析入口 Agent 的默认 tier（无参时走默认团队）。
        teamName: request.query.team_name?.trim() || null,
        selectedLlm,
      }),
      "runtime core readiness",
    );
  });
};
