import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import type { RouteOptions } from "../route-options.js";

interface RuntimeCoreStatusQuery {
  agent_name?: string;
  selected_llm?: string;
}

export const registerRuntimeCoreRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Querystring: RuntimeCoreStatusQuery }>("/runtime-core/status", async (request) => {
    const selectedLlm = request.query.selected_llm ?? null;
    return ok(
      request.container.runtimeCore.getReadiness({
        agentName: request.query.agent_name ?? null,
        selectedLlm,
      }),
      "runtime core readiness",
    );
  });
};
