import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";

import type { AppEnv } from "./config/env.js";
import { registerAgentConfigRoutes } from "./routes/agent-config.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerModelAdapterRoutes } from "./routes/model-adapter.js";
import { registerPermissionRoutes } from "./routes/permissions.js";
import { registerSystemConfigRoutes } from "./routes/system-config.js";
import { registerAgentRoutes } from "./routes/agent/index.js";
import { registerHealthRoutes } from "./routes/health.js";
import { HttpError, formatError } from "./utils/errors.js";
import { createRuntimeContainer, type RuntimeContainer } from "./services/runtime-container.js";

export interface BuildAppOptions {
  env: AppEnv;
  container?: RuntimeContainer;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const container =
    options.container ??
    createRuntimeContainer({
      dbPath: options.env.dbPath,
      checkpointDbPath: options.env.checkpointDbPath,
      dataRoot: options.env.dataRoot,
    });
  const app = Fastify({
    logger: {
      level: options.env.logLevel,
    },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send(formatError(error));
      return;
    }

    const validation =
      typeof error === "object" && error !== null && "validation" in error
        ? (error as { validation?: unknown }).validation
        : undefined;
    if (validation) {
      reply.code(400).send({
        success: false,
        message: error instanceof Error ? error.message : "validation error",
        details: [JSON.stringify(validation)],
      });
      return;
    }

    app.log.error({ error }, "unhandled request error");
    reply.code(500).send({
      success: false,
      message: "internal server error",
    });
  });

  await app.register(cors, {
    origin: options.env.corsOrigins,
    credentials: true,
  });
  await app.register(websocket);

  app.get("/", async () => ({
    name: "@ragsystem/backend-ts",
    status: "running",
    migration_status: "foundation",
  }));

  await app.register(registerHealthRoutes, {
    prefix: "/api",
    container,
  });
  await app.register(registerPermissionRoutes, {
    prefix: "/api/permissions",
    container,
  });
  await app.register(registerAgentConfigRoutes, {
    prefix: "/api/agent-config",
    container,
  });
  await app.register(registerModelAdapterRoutes, {
    prefix: "/api/model-adapter",
    container,
  });
  await app.register(registerSystemConfigRoutes, {
    prefix: "/api/system-config",
    container,
  });
  await app.register(registerMcpRoutes, {
    prefix: "/api/mcp",
    container,
  });
  await app.register(registerAgentRoutes, {
    prefix: "/api/agent",
    container,
  });

  return app;
}
