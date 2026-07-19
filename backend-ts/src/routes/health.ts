import type { FastifyPluginAsync } from "fastify";

import { ok } from "../contracts/common.js";
import type { ControlPlane } from "../contracts/control-plane/index.js";
import type { RouteOptions } from "./route-options.js";

interface ProbeRouteOptions {
  controlPlane: ControlPlane;
}

export const registerProbeRoutes: FastifyPluginAsync<ProbeRouteOptions> = async (app, options) => {
  app.get("/livez", async () => ({
    status: "alive",
  }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const readiness = await options.controlPlane.health.checkReadiness();
      if (!readiness.ready) throw new Error("control database is not ready");
      return {
        status: "ready",
        service: "ragsystem-backend",
        checks: {
          control_database: "ok",
          migrations: "ok",
          control_schema_version: readiness.currentSchemaVersion,
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

export const registerHealthRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/health", async (request) => {
    const saas = await options.resolveSessionApplication?.(request);
    const sessionsCount = saas
      ? (await saas.listSessions({ limit: 1, offset: 0, userIds: null })).total
      : request.container.sessionApplication.listSessions({ tenantId: request.identity.tenantId, limit: 1, offset: 0 }).total;
    return ok(
      {
        status: "healthy",
        backend: "backend-ts",
        migration_status: "runtime_migrated",
        sessions_count: sessionsCount,
        agents_count: request.container.agentConfig.listAgents().length,
      },
      "backend-ts health check passed",
    );
  });
};
