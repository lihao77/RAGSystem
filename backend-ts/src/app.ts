import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ZodError } from "zod";
import "./fastify-context.js";

import { resolveProfileFromSettings, type AppEnv } from "./config/env.js";
import type { DeploymentProfile } from "./identity/types.js";
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
import { registerBootstrapRoutes } from "./routes/bootstrap.js";
import { registerAuthRoutes, registerInstallRoutes } from "./routes/auth.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerPlatformRoutes } from "./routes/platform.js";
import { HttpError, formatError } from "./utils/errors.js";
import { createControlStore, type ControlStore } from "./services/stores/control-store/index.js";
import { createWidgetCredentialStore, type WidgetCredentialStore } from "./services/stores/widget-credential-store/index.js";
import { createWidgetAuthService, type WidgetAuthService } from "./services/runtime/jwt-service.js";
import { createSessionTokenService, type SessionTokenService } from "./services/runtime/session-token-service.js";
import { AuthError, LocalIdentityProvider, PasswordIdentityProvider, WidgetIdentityProvider, type IdentityProvider } from "./services/identity/index.js";
import { DefaultTenantRuntimeRegistry, type TenantRuntimeRegistry } from "./services/runtime/tenant-runtime-registry.js";
import { createTenantMigrator, type TenantMigrator } from "./services/runtime/tenant-migrator.js";

export interface BuildAppOptions {
  env: AppEnv;
  registry?: TenantRuntimeRegistry;
  controlStore?: ControlStore;
  identityProvider?: IdentityProvider;
  tenantMigrator?: Pick<TenantMigrator, "migrate">;
  widgetCredentialStore?: WidgetCredentialStore;
  widgetAuth?: WidgetAuthService;
  sessionTokens?: SessionTokenService;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: options.env.logLevel,
    },
  });
  const controlStore = options.controlStore ?? createControlStore(options.env.systemRoot);
  const tenantMigrator = options.tenantMigrator ?? createTenantMigrator(options.env);
  tenantMigrator.migrate();
  const initialProfile = resolveProfileFromSettings(controlStore.getAllSettings(), options.env);
  const initialSessionTokens = options.sessionTokens ?? createSessionTokens(initialProfile.auth, options.env, controlStore);
  const runtime: AuthRuntime = {
    profile: initialProfile,
    sessionTokens: initialSessionTokens,
    identityProvider: options.identityProvider ?? createIdentityProvider(initialProfile.auth, controlStore, initialSessionTokens),
  };
  const refreshProfile = (): DeploymentProfile => {
    const profile = resolveProfileFromSettings(controlStore.getAllSettings(), options.env);
    const sessionTokens = createSessionTokens(profile.auth, options.env, controlStore);
    const identityProvider = createIdentityProvider(profile.auth, controlStore, sessionTokens);
    Object.assign(runtime, { profile, sessionTokens, identityProvider });
    return profile;
  };
  const routedIdentityProvider: IdentityProvider = {
    resolve: (request) => runtime.identityProvider.resolve(request),
  };
  const widgetCredentialStore = options.widgetCredentialStore ?? createWidgetCredentialStore(controlStore.db);
  const widgetAuth = options.widgetAuth ?? (options.env.widgetJwtSecret
    ? createWidgetAuthService(options.env.widgetJwtSecret, widgetCredentialStore.ops)
    : undefined);
  const widgetIdentityProvider = widgetAuth ? new WidgetIdentityProvider(widgetAuth, widgetCredentialStore) : undefined;
  const registry = options.registry ?? new DefaultTenantRuntimeRegistry(options.env, controlStore, app.log);
  widgetCredentialStore.startPruning();
  app.decorateRequest("identity");
  app.decorateRequest("userId");
  app.decorateRequest("tenantId");
  app.decorateRequest("container");
  app.decorateRequest("tenantRuntimeLease", null);
  app.addHook("onRequest", async (request) => {
    const needsTenantRuntime = requiresTenantRuntime(request.url, request.method);
    if (!needsTenantRuntime && !usesAdminIdentity(request.url, request.method) && !usesPlatformIdentity(request.url, request.method)) return;
    const resolver = widgetIdentityProvider && usesWidgetIdentity(request.url)
      ? widgetIdentityProvider
      : runtime.identityProvider;
    let identity;
    try {
      identity = resolver.resolve(request);
    } catch (error) {
      if (error instanceof AuthError || usesWidgetIdentity(request.url)) {
        throw new HttpError(401, "unauthorized", error instanceof Error ? error.message : "认证失败");
      }
      throw error;
    }
    request.identity = identity;
    request.userId = identity.userId;
    request.tenantId = identity.tenantId;
    if (!needsTenantRuntime) return;
    const lease = await registry.acquire(identity.tenantId);
    request.container = lease.runtime;
    request.tenantRuntimeLease = lease;
  });
  const releaseRequestLease = (request: FastifyRequest): void => {
    request.tenantRuntimeLease?.release();
    request.tenantRuntimeLease = null;
  };
  app.addHook("onResponse", async (request) => releaseRequestLease(request));
  app.addHook("onError", async (request) => releaseRequestLease(request));
  app.addHook("onClose", async () => {
    await registry.closeAll();
    widgetCredentialStore.close();
    controlStore.close();
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
      const allowed = !origin ||
        options.env.corsOrigins === true ||
        (Array.isArray(options.env.corsOrigins) && options.env.corsOrigins.includes(origin));
      cb(null, allowed);
    },
    credentials: true,
    allowedHeaders: ["authorization", "content-type", "x-widget-key"],
  });
  const maxContentLength = 104_857_600;
  await app.register(multipart, {
    limits: {
      fileSize: maxContentLength,
      files: 20,
    },
  });
  await app.register(websocket);

  await app.register(registerHealthRoutes, {
    prefix: "/api",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerBootstrapRoutes, { prefix: "/api", env: options.env, controlStore, runtime });
  await app.register(registerInstallRoutes, { prefix: "/api", controlStore, runtime, refreshProfile });
  await app.register(registerAuthRoutes, { prefix: "/api/auth", controlStore, runtime });
  await app.register(registerAdminRoutes, { prefix: "/api/admin", controlStore });
  await app.register(registerPlatformRoutes, { prefix: "/api/platform", controlStore, registry });
  await app.register(registerPermissionRoutes, {
    prefix: "/api/permissions",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerArtifactRoutes, {
    prefix: "/api/artifacts",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerAgentConfigRoutes, {
    prefix: "/api/agent-config",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerSkillRoutes, {
    prefix: "/api/skills",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerModelAdapterRoutes, {
    prefix: "/api/model-adapter",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerSystemConfigRoutes, {
    prefix: "/api/system-config",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerMcpRoutes, {
    prefix: "/api/mcp",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerDaemonRoutes, {
    prefix: "/api/daemon",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerKnowledgeBaseRoutes, {
    prefix: "/api/knowledge-bases",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerEmbeddingModelRoutes, {
    prefix: "/api/embedding-models",
    registry,
    identityProvider: routedIdentityProvider,
  });
  await app.register(registerAgentRoutes, {
    prefix: "/api/agent",
    registry,
    identityProvider: routedIdentityProvider,
    widgetCredentialStore,
    ...(widgetAuth ? { widgetAuth } : {}),
  });
  await app.register(registerAguiRoutes, {
    prefix: "/api/agui",
    registry,
    identityProvider: routedIdentityProvider,
    widgetCredentialStore,
    ...(widgetAuth ? { widgetAuth } : {}),
  });
  await app.register(registerWidgetRoutes, {
    prefix: "/api/widget",
    registry,
    identityProvider: routedIdentityProvider,
    widgetCredentialStore,
    ...(widgetAuth ? { widgetAuth } : {}),
  });
  await app.register(registerWidgetAppsRoutes, {
    prefix: "/api/widget/apps",
    registry,
    identityProvider: routedIdentityProvider,
    widgetCredentialStore,
    ...(widgetAuth ? { widgetAuth } : {}),
  });

  registerFrontendFallback(app);

  return app;
}

function requiresTenantRuntime(url: string, method: string): boolean {
  if (method === "OPTIONS") return false;
  const pathname = url.split("?", 1)[0] ?? url;
  if (!pathname.startsWith("/api/")) return false;
  return pathname !== "/api/bootstrap"
    && pathname !== "/api/install"
    && pathname !== "/api/auth/login"
    && pathname !== "/api/auth/switch-tenant"
    && pathname !== "/api/auth/me"
    && !pathname.startsWith("/api/daemon/webhook/")
    && pathname !== "/api/widget/auth/token"
    && pathname !== "/api/admin"
    && !pathname.startsWith("/api/admin/")
    && pathname !== "/api/platform"
    && !pathname.startsWith("/api/platform/")
    && !pathname.endsWith("/ws");
}

function usesAdminIdentity(url: string, method: string): boolean {
  if (method === "OPTIONS") return false;
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/api/admin" || pathname.startsWith("/api/admin/");
}

function usesPlatformIdentity(url: string, method: string): boolean {
  if (method === "OPTIONS") return false;
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/api/platform" || pathname.startsWith("/api/platform/");
}

interface AuthRuntime {
  profile: DeploymentProfile;
  sessionTokens: SessionTokenService | undefined;
  identityProvider: IdentityProvider;
}

function createSessionTokens(authMode: string, env: AppEnv, controlStore: ControlStore): SessionTokenService | undefined {
  if (authMode !== "password") return undefined;
  const secret = env.sessionJwtSecret ?? (env.widgetJwtSecret
    ? createHash("sha256").update(`ragsystem-session:${env.widgetJwtSecret}`).digest("hex")
    : undefined);
  if (!secret) throw new Error("password 模式必须配置 SESSION_JWT_SECRET，或配置 WIDGET_JWT_SECRET 用于派生");
  return createSessionTokenService(secret, {
    isSessionRevoked: (tenantId, jti) => controlStore.isSessionRevoked(tenantId, jti),
    revokeSession: (jti) => controlStore.revokeSession(jti),
  }, env.sessionTokenTtlHours ?? 168);
}

function createIdentityProvider(
  authMode: string,
  controlStore: ControlStore,
  sessionTokens: SessionTokenService | undefined,
): IdentityProvider {
  if (authMode === "local") return new LocalIdentityProvider(controlStore);
  if (authMode === "password" && sessionTokens) return new PasswordIdentityProvider(controlStore, sessionTokens);
  if (authMode === "oidc") throw new Error("oidc 身份认证尚未实现");
  throw new Error(`无法创建身份 provider: ${authMode}`);
}

function usesWidgetIdentity(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return pathname === "/api/widget/sessions" || pathname.startsWith("/api/agui");
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
