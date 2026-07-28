import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";
import "./fastify-context.js";

import { resolveProfileFromSettings, type AppEnv } from "./config/env.js";
import type { ControlPlane } from "./contracts/control-plane/index.js";
import type { DeploymentProfile } from "./identity/types.js";
import type { DeploymentRuntime } from "./app/deployment-runtime.js";
import type { BackendPlugin } from "./plugins/backend-plugin.js";
import type { CapabilityProvider } from "./plugins/capability-registry.js";
import { BackendPluginManager } from "./plugins/plugin-manager.js";
import {
  registerManagementAndPlatformRoutes,
  registerPublicAndAuthRoutes,
  registerSharedBusinessRoutes,
  registerRealtimeRoutes,
  type AuthRuntime,
} from "./app/route-assembly.js";
import { HttpError, formatError } from "./utils/errors.js";
import { createSessionTokenService, type SessionTokenService } from "./services/runtime/session-token-service.js";
import { AuthError, type IdentityProvider } from "./services/identity/index.js";
export interface CoreBuildAppOptions {
  env: AppEnv;
  runtime: DeploymentRuntime;
  plugins?: readonly BackendPlugin[];
  capabilities?: readonly CapabilityProvider[];
}

export async function buildCoreApp(options: CoreBuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.env.logLevel,
    },
  });
  const deployment = options.runtime;
  const pluginManager = new BackendPluginManager(options.plugins, options.capabilities);
  await pluginManager.register();
  const controlPlane = deployment.controlPlane;
  const applications = deployment.applications;
  const initialProfile = resolveProfileFromSettings(await controlPlane.settings.getAll(), options.env);
  const initialSessionTokens = deployment.initialSessionTokens
    ?? createSessionTokens(initialProfile.auth, options.env, controlPlane);
  const runtime: AuthRuntime = {
    profile: initialProfile,
    sessionTokens: initialSessionTokens,
    identityProvider: await deployment.createIdentityProvider(initialProfile.auth, initialSessionTokens),
  };
  const refreshProfile = async (): Promise<DeploymentProfile> => {
    const profile = resolveProfileFromSettings(await controlPlane.settings.getAll(), options.env);
    const sessionTokens = createSessionTokens(profile.auth, options.env, controlPlane);
    const identityProvider = await deployment.createIdentityProvider(profile.auth, sessionTokens);
    Object.assign(runtime, { profile, sessionTokens, identityProvider });
    return profile;
  };
  const validateProfileSettings = (settings: Readonly<Record<string, string>>): void => {
    const profile = resolveProfileFromSettings(settings, options.env);
    try {
      createSessionTokens(profile.auth, options.env, controlPlane);
    } catch (error) {
      throw new HttpError(400, "invalid_configuration", error instanceof Error ? error.message : "目标 profile 配置无效");
    }
  };
  const routedIdentityProvider: IdentityProvider = {
    resolve: (request, scope) => runtime.identityProvider.resolve(request, scope),
  };
  const registry = await deployment.createRegistry(app.log, pluginManager.runtimeContributions());
  const wsTickets = deployment.wsTickets;
  await pluginManager.initializeApplication({ logger: app.log, registry });
  app.decorateRequest("identity");
  app.decorateRequest("userId");
  app.decorateRequest("tenantId");
  app.decorateRequest("container");
  app.decorateRequest("tenantRuntimeLease", null);
  app.decorateRequest("applications");
  const releaseRequestLease = (request: FastifyRequest): void => {
    request.tenantRuntimeLease?.release();
    request.tenantRuntimeLease = null;
  };
  app.addHook("onResponse", async (request) => releaseRequestLease(request));
  app.addHook("onError", async (request) => releaseRequestLease(request));
  app.addHook("onClose", async () => {
    const errors: unknown[] = [];
    try { await pluginManager.stop(); } catch (error) { errors.push(error); }
    try { await registry.closeAll(); } catch (error) { errors.push(error); }
    try { await deployment.close(); } catch (error) { errors.push(error); }
    if (errors.length > 0) throw new AggregateError(errors, "Backend shutdown failed");
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send(formatError(error));
      return;
    }

    if (error instanceof AuthError) {
      reply.code(401).send(formatError(new HttpError(401, "unauthorized", error.message)));
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

    app.log.error({ err: error }, "unhandled request error");
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
    origin: (origin, cb) => {
      const allowed = !origin ||
        options.env.corsOrigins === true ||
        (Array.isArray(options.env.corsOrigins) && options.env.corsOrigins.includes(origin));
      cb(null, allowed);
    },
    credentials: true,
  });
  const maxContentLength = 104_857_600;
  await app.register(multipart, {
    limits: {
      fileSize: maxContentLength,
      files: 20,
    },
  });
  await app.register(websocket);

  await registerPublicAndAuthRoutes(app, {
    env: options.env,
    controlPlane,
    runtime,
    refreshProfile,
    validateProfileSettings,
    pluginRoutes: pluginManager.routes("public"),
  });
  await registerSharedBusinessRoutes(app, {
    registry,
    identityProvider: routedIdentityProvider,
    wsTickets,
    registerPublicAgui: !pluginManager.routes("public").some((route) => route.prefix === "/api/agui"),
    ...applications,
    emitPluginEvent: (event, payload) => pluginManager.emit(event, payload),
    pluginRoutes: pluginManager.routes("tenant"),
  });
  await registerManagementAndPlatformRoutes(app, {
    controlPlane,
    registry,
    identityProvider: routedIdentityProvider,
    ...(applications.resolveExecutionRead ? { resolveExecutionRead: applications.resolveExecutionRead } : {}),
    pluginRoutes: [
      ...pluginManager.routes("management"),
      ...pluginManager.routes("platform"),
    ],
    emitPluginEvent: (event, payload) => pluginManager.emit(event, payload),
  });
  await registerRealtimeRoutes(app, {
    registry,
    identityProvider: routedIdentityProvider,
    wsTickets,
    resolveSessionApplication: applications.resolveSessionApplication,
    resolveExecutionRead: applications.resolveExecutionRead,
    resolveExecutionApplication: applications.resolveExecutionApplication,
    resolveAnalytics: applications.resolveAnalytics,
    resolveMonitoringApplication: applications.resolveMonitoringApplication,
    resolveProviderApplication: applications.resolveProviderApplication,
  });

  registerFrontendFallback(app);
  await pluginManager.start();

  return app;
}

function createSessionTokens(authMode: string, env: AppEnv, controlPlane: ControlPlane): SessionTokenService | undefined {
  if (authMode !== "password") return undefined;
  const secret = env.sessionJwtSecret;
  if (!secret) throw new Error("password 模式必须配置 SESSION_JWT_SECRET");
  return createSessionTokenService(secret, {
    isSessionRevoked: (tenantId, jti) => controlPlane.sessions.isRevoked(tenantId, jti),
    revokeSession: (jti) => controlPlane.sessions.revoke(jti),
  }, env.sessionTokenTtlHours ?? 168);
}

function registerFrontendFallback(app: FastifyInstance): void {
  const frontendDist = process.env.FRONTEND_DIST?.trim() || path.resolve(process.cwd(), "..", "frontend-client", "dist");
  const indexPath = path.join(frontendDist, "index.html");
  if (!fs.existsSync(indexPath)) {
    app.get("/", async () => ({
      name: "@ragsystem/backend-core",
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
