import type { FastifyPluginAsync } from "fastify";

import { ok } from "../contracts/common.js";
import type { RouteOptions } from "./route-options.js";

export const registerHealthRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/health", async () =>
    ok(
      {
        status: "healthy",
        backend: "backend-ts",
        migration_status: "runtime_migrated",
        sessions_count: options.container.sessionApplication.listSessions({ limit: 1, offset: 0 }).total,
      },
      "backend-ts health check passed",
    ),
  );

  app.get("/agent/health", async () =>
    ok(
      {
        status: "healthy",
        agents_count: options.container.agentConfig.listAgents().length,
        migration_status: "agent_runtime_migrated",
      },
      "backend-ts agent runtime is ready",
    ),
  );
};
