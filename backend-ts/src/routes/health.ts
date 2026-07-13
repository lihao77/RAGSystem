import type { FastifyPluginAsync } from "fastify";

import { ok } from "../contracts/common.js";
import type { RouteOptions } from "./route-options.js";

export const registerHealthRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/health", async (request) => {
    const identity = options.identityProvider.resolve(request);
    return ok(
      {
        status: "healthy",
        backend: "backend-ts",
        migration_status: "runtime_migrated",
        sessions_count: request.container.sessionApplication.listSessions({ tenantId: identity.tenantId, limit: 1, offset: 0 }).total,
      },
      "backend-ts health check passed",
    );
  });

  app.get("/agent/health", async (request) =>
    ok(
      {
        status: "healthy",
        agents_count: request.container.agentConfig.listAgents().length,
      },
      "智能体系统运行正常",
    ),
  );
};
