import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ZodError } from "zod";
import "./fastify-context.js";

import { resolveProfileFromSettings, type AppEnv } from "./config/env.js";
import type { DeploymentProfile } from "./identity/types.js";
import { registerAgentConfigRoutes } from "./routes/agent-config.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerBotRoutes } from "./routes/bots.js";
import { registerEmbeddingModelRoutes } from "./routes/embedding-models.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerModelAdapterRoutes } from "./routes/model-adapter.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerSystemConfigRoutes } from "./routes/system-config.js";
import { registerKnowledgeBaseRoutes } from "./routes/knowledge-base.js";
import { registerAgentRoutes } from "./routes/agent/index.js";
import { registerSessionWebSocketRoute } from "./routes/agent/ws.js";
import { registerAguiRoutes } from "./routes/agent/agui.js";
import { registerHealthRoutes, registerProbeRoutes } from "./routes/health.js";
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
import { createWsTicketService, type WsTicketService } from "./services/runtime/ws-ticket-service.js";
import { AuthError, LocalIdentityProvider, PasswordIdentityProvider, WidgetIdentityProvider, type IdentityProvider } from "./services/identity/index.js";
import { DefaultTenantRuntimeRegistry, type TenantRuntimeRegistry } from "./services/runtime/tenant-runtime-registry.js";
import { createTenantMigrator, type TenantMigrator } from "./services/runtime/tenant-migrator.js";
import { DaemonService, type DaemonSuspendedInteraction } from "./services/daemon/daemon-service.js";

export interface BuildAppOptions {
  env: AppEnv;
  registry?: TenantRuntimeRegistry;
  controlStore?: ControlStore;
  identityProvider?: IdentityProvider;
  tenantMigrator?: Pick<TenantMigrator, "migrate">;
  widgetCredentialStore?: WidgetCredentialStore;
  widgetAuth?: WidgetAuthService;
  sessionTokens?: SessionTokenService;
  botEngine?: DaemonService;
  wsTickets?: WsTicketService;
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
  const wsTickets = options.wsTickets ?? createWsTicketService();
  const botEngine = options.botEngine ?? new DaemonService({
    controlStore,
    registry,
    runAgentTask: async (input) => {
      const lease = await registry.acquire(input.tenantId);
      try {
        try {
          if (!lease.runtime.conversationStore.getSession(input.sessionId)) {
            lease.runtime.conversationStore.createSession(
              input.tenantId,
              input.sessionId,
              input.botId,
              {},
              input.permissionMode,
            );
          }
          const scheduledBatches = new Set<string>();
          const onInteractionRequired = (notice: { rootRunId: string; batchId: string }): void => {
            if (scheduledBatches.has(notice.batchId)) return;
            scheduledBatches.add(notice.batchId);
            queueMicrotask(() => {
              scheduledBatches.delete(notice.batchId);
              const metas = lease.runtime.pendingInteractions.listPendingApprovalMeta(notice.rootRunId, input.sessionId);
              if (metas.length === 0) return;
              input.onInteractionRequired?.(metas.map((item): DaemonSuspendedInteraction => ({
                approvalId: item.approvalId,
                sessionId: item.sessionId,
                botId: input.botId,
                rootRunId: item.rootRunId,
                kind: item.kind,
                ...(item.toolName ? { toolName: item.toolName } : {}),
                ...(item.riskLevel ? { riskLevel: item.riskLevel } : {}),
                ...(item.reason ? { reason: item.reason } : {}),
                ...(item.prompt ? { prompt: item.prompt } : {}),
                ...(item.options ? { options: item.options } : {}),
              })));
            });
          };
          const result = await lease.runtime.agentExecution.executeSynchronously({
            task: input.task,
            session_id: input.sessionId,
            agent: input.entryAgent,
            userId: input.botId,
            executionKind: input.source,
            onInteractionRequired,
          }, randomUUID());
          if (!result.success && !result.suspended) throw new Error(result.error ?? "agent 执行失败");
          if (result.suspended) {
            const rootRunId = result.rootRunId ?? result.run_id ?? "";
            const metas = lease.runtime.pendingInteractions.listPendingApprovalMeta(rootRunId, input.sessionId);
            const meta = metas[0];
            if (!meta) {
              throw new Error("Agent 已挂起，但未找到待处理交互");
            }
            const interactions = metas.map((item) => ({
              approvalId: item.approvalId,
              sessionId: item.sessionId,
              botId: input.botId,
              rootRunId: item.rootRunId,
              kind: item.kind,
              ...(item.toolName ? { toolName: item.toolName } : {}),
              ...(item.riskLevel ? { riskLevel: item.riskLevel } : {}),
              ...(item.reason ? { reason: item.reason } : {}),
              ...(item.prompt ? { prompt: item.prompt } : {}),
              ...(item.options ? { options: item.options } : {}),
            }));
            return {
              suspended: true,
              content: "",
              interaction: interactions[0]!,
              interactions,
            };
          }
          return { suspended: false, content: result.answer ?? "" };
        } finally {
          if (input.sessionMetadata) {
            lease.runtime.conversationStore.updateSessionMetadata(input.sessionId, input.sessionMetadata);
          }
        }
      } finally {
        lease.release();
      }
    },
  });
  botEngine.start();
  app.decorate("botEngine", botEngine);
  app.decorate("controlStore", controlStore);
  widgetCredentialStore.startPruning();
  app.decorateRequest("identity");
  app.decorateRequest("userId");
  app.decorateRequest("tenantId");
  app.decorateRequest("container");
  app.decorateRequest("tenantRuntimeLease", null);
  const releaseRequestLease = (request: FastifyRequest): void => {
    request.tenantRuntimeLease?.release();
    request.tenantRuntimeLease = null;
  };
  app.addHook("onResponse", async (request) => releaseRequestLease(request));
  app.addHook("onError", async (request) => releaseRequestLease(request));
  app.addHook("onClose", async () => {
    botEngine.close();
    await registry.closeAll();
    widgetCredentialStore.close();
    wsTickets.close();
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

  await app.register(registerProbeRoutes, { controlStore });
  await app.register(registerBootstrapRoutes, { prefix: "/api", env: options.env, controlStore, runtime });
  await app.register(registerInstallRoutes, { prefix: "/api", controlStore, runtime, refreshProfile });
  await app.register(registerAuthRoutes, { prefix: "/api/auth", controlStore, runtime });

  await app.register(async (scope) => {
    installIdentityScope(scope, { identityProvider: routedIdentityProvider, registry });
    const routeOptions = { registry, identityProvider: routedIdentityProvider };
    await scope.register(registerHealthRoutes, { prefix: "/api", ...routeOptions });
    await scope.register(registerArtifactRoutes, { prefix: "/api/artifacts", ...routeOptions });
    await scope.register(registerAgentConfigRoutes, { prefix: "/api/agent-config", ...routeOptions });
    await scope.register(registerSkillRoutes, { prefix: "/api/skills", ...routeOptions });
    await scope.register(registerModelAdapterRoutes, { prefix: "/api/model-adapter", ...routeOptions });
    await scope.register(registerSystemConfigRoutes, { prefix: "/api/system-config", ...routeOptions });
    await scope.register(registerMcpRoutes, { prefix: "/api/mcp", ...routeOptions });
    await scope.register(registerKnowledgeBaseRoutes, { prefix: "/api/knowledge-bases", ...routeOptions });
    await scope.register(registerEmbeddingModelRoutes, { prefix: "/api/embedding-models", ...routeOptions });
    await scope.register(registerAgentRoutes, {
      prefix: "/api/agent",
      ...routeOptions,
      widgetCredentialStore,
      wsTickets,
      ...(widgetAuth ? { widgetAuth } : {}),
    });
    if (!widgetIdentityProvider) {
      await scope.register(registerAguiRoutes, {
        prefix: "/api/agui",
        ...routeOptions,
        widgetCredentialStore,
      });
    }
  });

  await app.register(async (scope) => {
    installIdentityScope(scope, { identityProvider: routedIdentityProvider });
    await scope.register(registerAdminRoutes, { prefix: "/api/admin", controlStore });
    await scope.register(registerPlatformRoutes, { prefix: "/api/platform", controlStore, registry });
    await scope.register(registerBotRoutes, {
      prefix: "/api/bots",
      registry,
      identityProvider: routedIdentityProvider,
    });
    await scope.register(registerWidgetAppsRoutes, {
      prefix: "/api/widget/apps",
      registry,
      identityProvider: routedIdentityProvider,
      widgetCredentialStore,
      ...(widgetAuth ? { widgetAuth } : {}),
    });
  });

  if (widgetIdentityProvider && widgetAuth) {
    await app.register(async (scope) => {
      installIdentityScope(scope, { identityProvider: widgetIdentityProvider, registry, mapAllIdentityErrorsToUnauthorized: true });
      await scope.register(registerAguiRoutes, {
        prefix: "/api/agui",
        registry,
        identityProvider: routedIdentityProvider,
        widgetCredentialStore,
        widgetAuth,
      });
      await scope.register(registerWidgetRoutes, {
        prefix: "/api/widget",
        registry,
        identityProvider: routedIdentityProvider,
        widgetCredentialStore,
        wsTickets,
        widgetAuth,
      });
    });
  } else {
    await app.register(registerWidgetRoutes, {
      prefix: "/api/widget",
      registry,
      identityProvider: routedIdentityProvider,
      widgetCredentialStore,
      wsTickets,
    });
  }

  await app.register(registerSessionWebSocketRoute, {
    prefix: "/api/agent",
    registry,
    identityProvider: routedIdentityProvider,
    widgetCredentialStore,
    wsTickets,
    ...(widgetAuth ? { widgetAuth } : {}),
  });

  registerFrontendFallback(app);

  return app;
}

interface IdentityScopeOptions {
  identityProvider: IdentityProvider;
  registry?: TenantRuntimeRegistry;
  mapAllIdentityErrorsToUnauthorized?: boolean;
}

function installIdentityScope(app: FastifyInstance, options: IdentityScopeOptions): void {
  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS" || isExplicitPublicRoute(request)) return;
    let identity;
    try {
      identity = options.identityProvider.resolve(request);
    } catch (error) {
      if (error instanceof AuthError || options.mapAllIdentityErrorsToUnauthorized) {
        throw new HttpError(401, "unauthorized", error instanceof Error ? error.message : "认证失败");
      }
      throw error;
    }
    request.identity = identity;
    request.userId = identity.userId;
    request.tenantId = identity.tenantId;
    if (!options.registry) return;
    const lease = await options.registry.acquire(identity.tenantId);
    request.container = lease.runtime;
    request.tenantRuntimeLease = lease;
  });
}

function isExplicitPublicRoute(request: FastifyRequest): boolean {
  const config = request.routeOptions.config as { auth?: unknown };
  return config.auth === "public";
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
