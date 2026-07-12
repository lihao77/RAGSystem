import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";

import type { AppEnv } from "./config/env.js";
import { registerAgentConfigRoutes } from "./routes/agent-config.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerDaemonRoutes } from "./routes/daemon.js";
import { registerEmbeddingModelRoutes } from "./routes/embedding-models.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerModelAdapterRoutes } from "./routes/model-adapter.js";
import { registerPermissionRoutes } from "./routes/permissions.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerSystemConfigRoutes } from "./routes/system-config.js";
import { registerKnowledgeBaseRoutes } from "./routes/knowledge-base.js";
import { registerAgentRoutes } from "./routes/agent/index.js";
import { registerAguiRoutes } from "./routes/agent/agui.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerWidgetRoutes } from "./routes/widget.js";
import { registerWidgetAppsRoutes } from "./routes/widget-apps.js";
import { HttpError, formatError } from "./utils/errors.js";
import { createRuntimeContainer, type RuntimeContainer } from "./services/runtime/runtime-container.js";

export interface BuildAppOptions {
  env: AppEnv;
  container?: RuntimeContainer;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.env.logLevel,
    },
  });
  const container =
    options.container ??
    createRuntimeContainer({
      dbPath: options.env.dbPath,
      dataRoot: options.env.dataRoot,
      logger: app.log,
      ...(options.env.widgetJwtSecret ? { widgetJwtSecret: options.env.widgetJwtSecret } : {}),
    });
  app.addHook("onClose", async () => {
    container.close();
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

  app.addContentTypeParser(
    [
      "application/x-yaml",
      "application/yaml",
      "application/vnd.yaml",
      "text/yaml",
      "text/x-yaml",
    ],
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  await app.register(cors, {
    // widget 鉴权启用时，CORS 白名单 = env CORS_ORIGINS ∪ 各 app 的 allowed_origins；
    // 未启用时保持原 corsOrigins 行为（true 全开或显式数组），默认部署不受影响。
    origin: (origin, cb) => {
      const widgetAuth = container.widgetAuth;
      const allowed = widgetAuth
        ? widgetAuth.isOriginAllowed(origin, options.env.corsOrigins)
        : !origin ||
          options.env.corsOrigins === true ||
          (Array.isArray(options.env.corsOrigins) && origin != null && options.env.corsOrigins.includes(origin));
      cb(null, allowed);
    },
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "x-widget-key"],
  });
  const maxContentLength = container.systemConfig.getSystemGroupConfig().max_content_length;
  await app.register(multipart, {
    limits: {
      fileSize: maxContentLength,
      files: 20,
    },
  });
  await app.register(websocket);

  await app.register(registerHealthRoutes, {
    prefix: "/api",
    container,
  });
  await app.register(registerPermissionRoutes, {
    prefix: "/api/permissions",
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
  await app.register(registerSkillRoutes, {
    prefix: "/api/skills",
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
  await app.register(registerKnowledgeBaseRoutes, {
    prefix: "/api/knowledge-bases",
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
  await app.register(registerAguiRoutes, {
    prefix: "/api/agui",
    container,
  });
  await app.register(registerWidgetRoutes, {
    prefix: "/api/widget",
    container,
  });
  await app.register(registerWidgetAppsRoutes, {
    prefix: "/api/widget/apps",
    container,
  });

  registerFrontendFallback(app);

  return app;
}

function registerFrontendFallback(app: FastifyInstance): void {
  const frontendDist = process.env.FRONTEND_DIST?.trim() || path.resolve(process.cwd(), "..", "frontend-client", "dist");
  const indexPath = path.join(frontendDist, "index.html");
  if (!fs.existsSync(indexPath)) {
    app.get("/", async () => ({
      name: "@ragsystem/backend-ts",
      status: "running",
      migration_status: "runtime_migrated",
    }));
    return;
  }

  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(fs.createReadStream(indexPath)));
  app.get("/*", async (request, reply) => {
    const rawPath = request.url.split("?", 1)[0] ?? "/";
    if (rawPath.startsWith("/api/")) {
      return reply.code(404).send({
        message: `Route GET:${rawPath} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    }
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(rawPath).replace(/^\/+/, "");
    } catch {
      return reply.code(400).send({ message: "Invalid URL encoding", error: "Bad Request", statusCode: 400 });
    }
    const candidate = path.resolve(frontendDist, relativePath);
    const relativeCandidate = path.relative(path.resolve(frontendDist), candidate);
    if (!relativeCandidate.startsWith("..") && !path.isAbsolute(relativeCandidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return reply.type(frontendContentType(candidate)).send(fs.createReadStream(candidate));
    }
    return reply.type("text/html; charset=utf-8").send(fs.createReadStream(indexPath));
  });
}

function frontendContentType(filePath: string): string {
  const contentTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
  };
  return contentTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
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
