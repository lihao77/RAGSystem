import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import type { AppEnv } from "./config/env.js";
import { registerAgentConfigRoutes } from "./routes/agent-config.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerDaemonRoutes } from "./routes/daemon.js";
import { registerEmbeddingModelRoutes } from "./routes/embedding-models.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerModelAdapterRoutes } from "./routes/model-adapter.js";
import { registerPermissionRoutes } from "./routes/permissions.js";
import { registerSystemConfigRoutes } from "./routes/system-config.js";
import { registerVectorRoutes } from "./routes/vector.js";
import { registerVectorLibraryRoutes } from "./routes/vector-library.js";
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

    if (error instanceof ZodError) {
      reply.code(400).send({
        success: false,
        message: "validation error",
        code: "invalid_request",
        details: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`),
      });
      return;
    }

    const statusCode = fastifyClientErrorStatusCode(error);
    if (statusCode !== null) {
      reply.code(statusCode).send({
        success: false,
        message: error instanceof Error ? error.message : "request error",
        code: statusCode === 415 ? "unsupported_media_type" : "invalid_request",
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
  await app.register(multipart, {
    limits: {
      fileSize: 100 * 1024 * 1024,
      files: 20,
    },
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
  await app.register(registerFileRoutes, {
    prefix: "/api/files",
    container,
  });
  await app.register(registerArtifactRoutes, {
    prefix: "/api/artifacts",
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
  await app.register(registerDaemonRoutes, {
    prefix: "/api/daemon",
    container,
  });
  await app.register(registerVectorLibraryRoutes, {
    prefix: "/api/vector-library",
    container,
  });
  await app.register(registerVectorRoutes, {
    prefix: "/api/vector",
    container,
  });
  await app.register(registerEmbeddingModelRoutes, {
    prefix: "/api/embedding-models",
    container,
  });
  await app.register(registerAgentRoutes, {
    prefix: "/api/agent",
    container,
  });

  return app;
}

function fastifyClientErrorStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const maybeError = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  const statusCode = numericStatus(maybeError.statusCode) ?? numericStatus(maybeError.status);
  if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
    return statusCode;
  }
  if (maybeError.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
    return 415;
  }
  return null;
}

function numericStatus(value: unknown): number | null {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}
