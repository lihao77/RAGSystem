import type { FastifyPluginAsync } from "fastify";

import { ok } from "../contracts/common.js";
import type { ControlStore } from "../services/stores/control-store/index.js";
import type { RouteOptions } from "./route-options.js";

interface ProbeRouteOptions {
  controlStore: ControlStore;
}

export const registerProbeRoutes: FastifyPluginAsync<ProbeRouteOptions> = async (app, options) => {
  app.get("/livez", async () => ({
    status: "alive",
  }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const row = options.controlStore.db.prepare("SELECT 1 AS ready").get() as { ready?: number } | undefined;
      if (row?.ready !== 1) throw new Error("control database probe returned an unexpected result");
      return {
        status: "ready",
        service: "ragsystem-backend",
        checks: {
          control_database: "ok",
          migrations: "ok",
        },
      };
    } catch {
      return reply.code(503).send({
        status: "not_ready",
        service: "ragsystem-backend",
        checks: {
          control_database: "failed",
        },
      });
    }
  });
};

export const registerHealthRoutes: FastifyPluginAsync<RouteOptions> = async (app) => {
  app.get("/health", async (request) => {
    return ok(
      {
        status: "healthy",
        backend: "backend-ts",
        migration_status: "runtime_migrated",
        sessions_count: request.container.sessionApplication.listSessions({ tenantId: request.identity.tenantId, limit: 1, offset: 0 }).total,
        agents_count: request.container.agentConfig.listAgents().length,
      },
      "backend-ts health check passed",
    );
  });
};
