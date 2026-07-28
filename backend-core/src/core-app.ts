import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
  registerWidgetAndRealtimeRoutes,
  type AuthRuntime,
} from "./app/route-assembly.js";
import { HttpError, formatError } from "./utils/errors.js";
import { createWidgetAuthService } from "./services/runtime/jwt-service.js";
import { createSessionTokenService, type SessionTokenService } from "./services/runtime/session-token-service.js";
import { AuthError, WidgetIdentityProvider, type IdentityProvider } from "./services/identity/index.js";
import { DaemonService, type DaemonSuspendedInteraction } from "./services/daemon/daemon-service.js";
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
  const botRepository = deployment.botRepository;
  const widgetCredentials = deployment.widgetCredentials;
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
  const widgetAuth = deployment.widgetAuth ?? (options.env.widgetJwtKeyRing
    ? createWidgetAuthService(options.env.widgetJwtKeyRing, widgetCredentials)
    : undefined);
  const widgetIdentityProvider = widgetAuth ? new WidgetIdentityProvider(widgetAuth, widgetCredentials) : undefined;
  const registry = await deployment.createRegistry(app.log, pluginManager.runtimeContributions());
  const wsTickets = deployment.wsTickets;
  const botEngine = deployment.botEngine ?? new DaemonService({
    botRepository,
    registry,
    ...(deployment.daemonLeaderLease ? { leaderLease: deployment.daemonLeaderLease } : {}),
    runAgentTask: async (input) => {
      const lease = await registry.acquire(input.tenantId);
      try {
        try {
          const existing = await lease.runtime.sessionApplication.getSession(input.sessionId);
          // 会话绑定字段只在创建时写入：team 缺省时快照当前激活 team；entry_agent 写本轮入口。
          // 已有会话不回写 team/entry_agent，避免 bot 配置变更污染历史会话。
          let createMetadata = input.sessionMetadata ? { ...input.sessionMetadata } : {};
          if (!existing) {
            const teams = await lease.runtime.agentConfig.listTeams();
            const configuredTeam = typeof input.team === "string" ? input.team.trim() : "";
            const team = configuredTeam || teams.active_team || "";
            if (team) createMetadata = { ...createMetadata, team };
            let entryAgent = typeof input.entryAgent === "string" ? input.entryAgent.trim() : "";
            if (!entryAgent) {
              const configs = lease.runtime.agentConfig.listConfigs({ teamName: team || null });
              const defaultEntry = Object.values(configs).find((config) => config.default_entry);
              entryAgent = defaultEntry?.agent_name?.trim() || "";
            }
            if (entryAgent) createMetadata = { ...createMetadata, entry_agent: entryAgent };
          } else {
            // 已有会话：只同步通道元数据（chatId 等），剥离绑定字段
            const { team: _team, entry_agent: _entry, ...channelMeta } = createMetadata as Record<string, unknown>;
            createMetadata = channelMeta;
          }
          const sessionBot = await botRepository.get(input.botId);
          if (!sessionBot) throw new Error(`bot 不存在: ${input.botId}`);
          await lease.runtime.sessionApplication.ensureSession({
            sessionId: input.sessionId,
            ownerUserId: sessionBot.owner_id,
            visibility: "private",
            originType: "bot",
            originId: input.botId,
            originChannel: input.source.includes("cron") ? "cron" : input.source.includes("feishu") ? "feishu" : "api",
            workspaceId: null,
            ...(Object.keys(createMetadata).length > 0 ? { metadata: createMetadata } : {}),
            permissionMode: input.permissionMode,
          });
          const scheduledBatches = new Set<string>();
          const onInteractionRequired = (notice: { rootRunId: string; batchId: string }): void => {
            if (scheduledBatches.has(notice.batchId)) return;
            scheduledBatches.add(notice.batchId);
            queueMicrotask(() => void (async () => {
              scheduledBatches.delete(notice.batchId);
              const metas = (await lease.runtime.interactionCoordinator.listPendingAsync(
                notice.rootRunId,
                input.sessionId,
              )).map((item): DaemonSuspendedInteraction => ({
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
              if (metas.length === 0) return;
              input.onInteractionRequired?.(metas);
            })().catch((error: unknown) => {
              app.log.error({ error, sessionId: input.sessionId }, "failed to load daemon pending interactions");
            }));
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
            const metas = await lease.runtime.interactionCoordinator.listPendingAsync(rootRunId, input.sessionId);
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
          // 仅同步通道侧元数据；team/entry_agent 只在创建时写入，禁止 finally 回写覆盖
          if (input.sessionMetadata) {
            const { team: _team, entry_agent: _entry, ...channelMeta } = input.sessionMetadata as Record<string, unknown>;
            if (Object.keys(channelMeta).length > 0) {
              await lease.runtime.sessionApplication.updateSessionMetadata(input.sessionId, channelMeta);
            }
          }
        }
      } finally {
        lease.release();
      }
    },
  });
  app.decorate("botEngine", botEngine);
  app.decorate("botRepository", botRepository);
  await widgetCredentials.startPruning();
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
    try { botEngine.close(); } catch (error) { errors.push(error); }
    try { await registry.closeAll(); } catch (error) { errors.push(error); }
    try { await pluginManager.stop(); } catch (error) { errors.push(error); }
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
    botRepository,
    widgetCredentialStore: widgetCredentials,
    wsTickets,
    registerPublicAgui: !widgetIdentityProvider,
    ...applications,
    ...(widgetAuth ? { widgetAuth } : {}),
    pluginRoutes: pluginManager.routes("tenant"),
  });
  await registerManagementAndPlatformRoutes(app, {
    controlPlane,
    registry,
    identityProvider: routedIdentityProvider,
    botRepository,
    widgetCredentialStore: widgetCredentials,
    ...(widgetAuth ? { widgetAuth } : {}),
    ...(applications.resolveExecutionRead ? { resolveExecutionRead: applications.resolveExecutionRead } : {}),
    pluginRoutes: [
      ...pluginManager.routes("management"),
      ...pluginManager.routes("platform"),
    ],
  });
  await registerWidgetAndRealtimeRoutes(app, {
    registry,
    identityProvider: routedIdentityProvider,
    botRepository,
    widgetCredentialStore: widgetCredentials,
    wsTickets,
    ...(widgetIdentityProvider ? { widgetIdentityProvider } : {}),
    ...(widgetAuth ? { widgetAuth } : {}),
    resolveSessionApplication: applications.resolveSessionApplication,
    resolveExecutionRead: applications.resolveExecutionRead,
    resolveExecutionApplication: applications.resolveExecutionApplication,
    resolveAnalytics: applications.resolveAnalytics,
    resolveMonitoringApplication: applications.resolveMonitoringApplication,
    resolveProviderApplication: applications.resolveProviderApplication,
    pluginRoutes: pluginManager.routes("widget"),
  });

  registerFrontendFallback(app);
  await pluginManager.start();
  try {
    await botEngine.start();
  } catch (error) {
    try {
      await pluginManager.stop();
    } catch (stopError) {
      throw new AggregateError([error, stopError], "Bot engine startup and plugin rollback failed");
    }
    throw error;
  }

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
