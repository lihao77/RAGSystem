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
import {
  registerManagementAndPlatformRoutes,
  registerPublicAndAuthRoutes,
  registerSharedBusinessRoutes,
  registerWidgetAndRealtimeRoutes,
  type AuthRuntime,
} from "./app/route-assembly.js";
import { HttpError, formatError } from "./utils/errors.js";
import { createControlStore, type ControlStore } from "./adapters/local/sqlite/control-store/index.js";
import { SqliteControlPlaneAdapter } from "./adapters/local/sqlite/sqlite-control-plane-adapter.js";
import { SqliteBotRepository } from "./adapters/local/sqlite/sqlite-bot-repository.js";
import { SqliteWidgetCredentialAdapter } from "./adapters/local/sqlite/sqlite-widget-credential-adapter.js";
import type { BotRepository } from "./contracts/control-plane/bot-repository.js";
import type { WidgetCredentialRepository } from "./contracts/control-plane/widget-credentials.js";
import { createWidgetCredentialStore, type WidgetCredentialStore } from "./adapters/local/sqlite/widget-credential-store/index.js";
import { createWidgetAuthService, type WidgetAuthService } from "./services/runtime/jwt-service.js";
import { createSessionTokenService, type SessionTokenService } from "./services/runtime/session-token-service.js";
import { createWsTicketService, type WsTicketService } from "./services/runtime/ws-ticket-service.js";
import { AuthError, LocalIdentityProvider, PasswordIdentityProvider, WidgetIdentityProvider, type IdentityProvider } from "./services/identity/index.js";
import { DefaultTenantRuntimeRegistry, type TenantRuntimeRegistry } from "./adapters/local/tenant-runtime-registry.js";
import { DaemonService, type DaemonSuspendedInteraction } from "./services/daemon/daemon-service.js";
import { createSaaSMemoryApplicationResolver } from "./adapters/saas/composition/saas-memory-resolver.js";
import type { RouteOptions } from "./routes/route-options.js";
import type { SaaSMemoryRuntimeHandle } from "./adapters/saas/composition/saas-memory-runtime.js";
import type { SaaSConversationRuntimeHandle } from "./adapters/saas/composition/saas-conversation-runtime.js";
import { AsyncKernelEventPersister } from "./services/agent/sdk/async-event-persister.js";
import { AsyncOutboxDispatcher } from "./services/runtime/event-outbox/async-dispatcher.js";
import { AsyncDurableClientEventPublisher } from "./services/runtime/event-outbox/async-client-event-publisher.js";
import type { SaaSControlRuntimeHandle } from "./adapters/saas/composition/saas-control-runtime.js";
import { SaaSSessionControlApplication } from "./adapters/saas/application/execution/saas-session-control-application.js";
import { SaaSDaemonState } from "./adapters/saas/composition/saas-daemon-state.js";
import { createPostgresExecutionStorage } from "./adapters/saas/postgres/postgres-execution-storage.js";

export interface BuildAppOptions {
  env: AppEnv;
  saasMemoryRuntime?: SaaSMemoryRuntimeHandle;
  saasConversationRuntime?: SaaSConversationRuntimeHandle;
  resolveMemoryApplication?: RouteOptions["resolveMemoryApplication"];
  resolveKnowledgeFileStore?: RouteOptions["resolveKnowledgeFileStore"];
  resolveSessionFileStorage?: RouteOptions["resolveSessionFileStorage"];
  resolveFileHistoryStorage?: RouteOptions["resolveFileHistoryStorage"];
  resolveKnowledgeMarkdownPipeline?: RouteOptions["resolveKnowledgeMarkdownPipeline"];
  resolveKnowledgeVectorApplication?: RouteOptions["resolveKnowledgeVectorApplication"];
  resolveProviderMcp?: RouteOptions["resolveProviderMcp"];
  resolveSessionApplication?: RouteOptions["resolveSessionApplication"];
  resolveExecutionRead?: RouteOptions["resolveExecutionRead"];
  resolveInteractionRecovery?: RouteOptions["resolveInteractionRecovery"];
  resolveAnalytics?: RouteOptions["resolveAnalytics"];
  resolveMonitoringApplication?: RouteOptions["resolveMonitoringApplication"];
  resolveArtifactApplication?: RouteOptions["resolveArtifactApplication"];
  registry?: TenantRuntimeRegistry;
  controlStore?: ControlStore;
  controlPlane?: ControlPlane;
  controlRuntime?: SaaSControlRuntimeHandle;
  identityProvider?: IdentityProvider;
  botRepository?: BotRepository;
  widgetCredentialStore?: WidgetCredentialStore;
  widgetCredentials?: WidgetCredentialRepository;
  widgetAuth?: WidgetAuthService;
  sessionTokens?: SessionTokenService;
  botEngine?: DaemonService;
  wsTickets?: WsTicketService;
}
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  if (options.env.controlStorageMode === "postgres" && !options.controlRuntime) {
    throw new Error(
      "CONTROL_STORAGE_MODE=postgres requires SaaSControlRuntime (PostgreSQL Control, Bot, Widget and Identity repositories)",
    );
  }
  if (options.saasMemoryRuntime && (options.registry || options.resolveMemoryApplication)) {
    throw new Error(
      "saasMemoryRuntime must own Memory composition; custom registry/resolveMemoryApplication would split Memory backends",
    );
  }
  if (options.controlRuntime && (options.controlStore || options.controlPlane || options.botRepository || options.widgetCredentials || options.widgetCredentialStore)) {
    throw new Error("controlRuntime owns Control, Bot and Widget composition; do not provide legacy stores");
  }
  if (options.controlPlane && !options.controlRuntime && (
    !options.controlStore
    || !(options.controlPlane instanceof SqliteControlPlaneAdapter)
    || options.controlPlane.store !== options.controlStore
  )) {
    throw new Error("custom controlPlane must wrap the same SQLite controlStore in local mode");
  }
  const app = Fastify({
    logger: {
      level: options.env.logLevel,
    },
  });
  const controlStore = options.controlStore ?? (options.controlRuntime ? undefined : createControlStore(options.env.systemRoot));
  const controlPlane = options.controlRuntime?.controlPlane ?? options.controlPlane ?? new SqliteControlPlaneAdapter(controlStore!);
  const botRepository = options.controlRuntime?.botRepository ?? options.botRepository ?? new SqliteBotRepository(controlStore!);
  const initialProfile = resolveProfileFromSettings(await controlPlane.settings.getAll(), options.env);
  const initialSessionTokens = options.sessionTokens ?? createSessionTokens(initialProfile.auth, options.env, controlPlane);
  const runtime: AuthRuntime = {
    profile: initialProfile,
    sessionTokens: initialSessionTokens,
    identityProvider: options.identityProvider ?? createIdentityProvider(initialProfile.auth, controlPlane, initialSessionTokens),
  };
  if (runtime.identityProvider instanceof LocalIdentityProvider) await runtime.identityProvider.initialize();
  const refreshProfile = async (): Promise<DeploymentProfile> => {
    const profile = resolveProfileFromSettings(await controlPlane.settings.getAll(), options.env);
    const sessionTokens = createSessionTokens(profile.auth, options.env, controlPlane);
    const identityProvider = createIdentityProvider(profile.auth, controlPlane, sessionTokens);
    if (identityProvider instanceof LocalIdentityProvider) await identityProvider.initialize();
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
  const widgetCredentialStore = options.widgetCredentialStore
    ?? (options.widgetCredentials || options.controlRuntime ? undefined : createWidgetCredentialStore(controlStore!.db));
  const widgetCredentials = options.controlRuntime?.widgetCredentials
    ?? options.widgetCredentials
    ?? new SqliteWidgetCredentialAdapter(widgetCredentialStore!);
  const widgetAuth = options.widgetAuth ?? (options.env.widgetJwtKeyRing
    ? createWidgetAuthService(options.env.widgetJwtKeyRing, widgetCredentials)
    : undefined);
  const widgetIdentityProvider = widgetAuth ? new WidgetIdentityProvider(widgetAuth, widgetCredentials) : undefined;
  const saasExecutionStorageFactory = options.saasConversationRuntime
    ? (input: { tenantId: import("./identity/types.js").TenantId; asyncClientEvents?: AsyncDurableClientEventPublisher }) => {
        if (!input.asyncClientEvents) throw new Error("SaaS execution storage requires durable client events");
        return createPostgresExecutionStorage({
          tenantId: input.tenantId,
          conversation: options.saasConversationRuntime!.conversation,
          providerContinuations: options.saasConversationRuntime!.providerContinuations,
          clientEvents: input.asyncClientEvents,
          createEventPersister: (context) => new AsyncKernelEventPersister(
            options.saasConversationRuntime!.conversation,
            options.saasConversationRuntime!.runs,
            context,
            options.saasConversationRuntime!.createFileHistoryStorage(context.tenantId),
          ),
        });
      }
    : undefined;
  const registry = options.registry ?? new DefaultTenantRuntimeRegistry(
    options.env,
    controlPlane.tenants,
    app.log,
    options.saasMemoryRuntime
      ? {
          ...(options.saasConversationRuntime ? {
            prepareRuntime: async (tenantId: import("./identity/types.js").TenantId, runtime: import("./contracts/runtime/runtime-container.js").RuntimeContainer) => {
              runtime.modelAdapter.replaceRuntimeProviders(
                await options.saasConversationRuntime!.providerMcpApplication.listProviders(tenantId),
              );
            },
          } : {}),
          runtimeOptions: {
            hostToolsEnabled: false,
            memoryBindingsFactory: (input) => options.saasMemoryRuntime!.provider.createMemoryBindings(
              input.tenantId,
              input.sessions,
            ),
            ...(saasExecutionStorageFactory ? { executionStorageFactory: saasExecutionStorageFactory } : {}),
            ...(options.saasConversationRuntime ? {
              asyncEventPersisterFactory: (context: import("./services/agent/sdk/async-event-persister.js").AsyncPersisterRunContext) => new AsyncKernelEventPersister(
                options.saasConversationRuntime!.conversation,
                options.saasConversationRuntime!.runs,
                context,
                options.saasConversationRuntime!.createFileHistoryStorage(context.tenantId),
              ),
              asyncConversationHistory: options.saasConversationRuntime!.conversation,
              asyncBackgroundTasks: options.saasConversationRuntime!.backgroundTasks,
              asyncAnalytics: options.saasConversationRuntime!.analytics,
              asyncProviderContinuations: options.saasConversationRuntime!.providerContinuations,
              knowledgeQueryFactory: ({ tenantId, baseKnowledge }) => options.saasConversationRuntime!.createKnowledgeQuery(tenantId, baseKnowledge),
              asyncSuspendedSessionControlFactory: (tenantId) => new SaaSSessionControlApplication(
                tenantId,
                options.saasConversationRuntime!.conversation,
                options.saasConversationRuntime!.runs,
                options.saasConversationRuntime!.pendingInteractions,
              ),
              asyncClientEventsFactory: (realtimeEvents: { publish(sessionId: string, event: import("./contracts/events.js").Envelope): void }) => new AsyncDurableClientEventPublisher(
                options.saasConversationRuntime!.outbox,
                new AsyncOutboxDispatcher(options.saasConversationRuntime!.outbox, realtimeEvents as ConstructorParameters<typeof AsyncOutboxDispatcher>[1]),
              ),
            } : {}),
          },
        }
      : options.saasConversationRuntime
        ? {
          prepareRuntime: async (tenantId: import("./identity/types.js").TenantId, runtime: import("./contracts/runtime/runtime-container.js").RuntimeContainer) => {
            runtime.modelAdapter.replaceRuntimeProviders(
              await options.saasConversationRuntime!.providerMcpApplication.listProviders(tenantId),
            );
          },
          runtimeOptions: {
            hostToolsEnabled: false,
            ...(saasExecutionStorageFactory ? { executionStorageFactory: saasExecutionStorageFactory } : {}),
            asyncEventPersisterFactory: (context: import("./services/agent/sdk/async-event-persister.js").AsyncPersisterRunContext) => new AsyncKernelEventPersister(
              options.saasConversationRuntime!.conversation,
              options.saasConversationRuntime!.runs,
              context,
              options.saasConversationRuntime!.createFileHistoryStorage(context.tenantId),
            ),
            asyncConversationHistory: options.saasConversationRuntime!.conversation,
            asyncBackgroundTasks: options.saasConversationRuntime!.backgroundTasks,
            asyncAnalytics: options.saasConversationRuntime!.analytics,
            asyncProviderContinuations: options.saasConversationRuntime!.providerContinuations,
            knowledgeQueryFactory: ({ tenantId, baseKnowledge }) => options.saasConversationRuntime!.createKnowledgeQuery(tenantId, baseKnowledge),
            asyncSuspendedSessionControlFactory: (tenantId) => new SaaSSessionControlApplication(
              tenantId,
              options.saasConversationRuntime!.conversation,
              options.saasConversationRuntime!.runs,
              options.saasConversationRuntime!.pendingInteractions,
            ),
            asyncClientEventsFactory: (realtimeEvents: { publish(sessionId: string, event: import("./contracts/events.js").Envelope): void }) => new AsyncDurableClientEventPublisher(
              options.saasConversationRuntime!.outbox,
              new AsyncOutboxDispatcher(options.saasConversationRuntime!.outbox, realtimeEvents as ConstructorParameters<typeof AsyncOutboxDispatcher>[1]),
            ),
          } }
        : {},
  );
  const resolveMemoryApplication = options.resolveMemoryApplication
    ?? (options.saasMemoryRuntime
      ? createSaaSMemoryApplicationResolver(options.saasMemoryRuntime.provider)
      : undefined);
  const wsTickets = options.wsTickets ?? createWsTicketService();
  const saasDaemonState = options.saasConversationRuntime
    ? new SaaSDaemonState(
        options.saasConversationRuntime.conversation,
        options.saasConversationRuntime.pendingInteractions,
      )
    : null;
  const botEngine = options.botEngine ?? new DaemonService({
    botRepository,
    registry,
    ...(options.controlRuntime ? { leaderLease: options.controlRuntime.daemonLeaderLease } : {}),
    runAgentTask: async (input) => {
      const lease = await registry.acquire(input.tenantId);
      try {
        try {
          if (saasDaemonState) {
            await saasDaemonState.ensureSession({
              tenantId: input.tenantId,
              sessionId: input.sessionId,
              botId: input.botId,
              ...(input.sessionMetadata ? { metadata: input.sessionMetadata } : {}),
              permissionMode: input.permissionMode,
            });
          } else if (!lease.runtime.conversationStore.getSession(input.sessionId)) {
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
            queueMicrotask(() => void (async () => {
              scheduledBatches.delete(notice.batchId);
              const metas = saasDaemonState
                ? await saasDaemonState.listSuspendedInteractions({
                    tenantId: input.tenantId,
                    sessionId: input.sessionId,
                    rootRunId: notice.rootRunId,
                    botId: input.botId,
                  })
                : lease.runtime.pendingInteractions.listPendingApprovalMeta(notice.rootRunId, input.sessionId)
                    .map((item): DaemonSuspendedInteraction => ({
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
            const metas = saasDaemonState
              ? await saasDaemonState.listSuspendedInteractions({
                  tenantId: input.tenantId,
                  sessionId: input.sessionId,
                  rootRunId,
                  botId: input.botId,
                })
              : lease.runtime.pendingInteractions.listPendingApprovalMeta(rootRunId, input.sessionId);
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
            if (saasDaemonState) {
              await saasDaemonState.updateMetadata(input.tenantId, input.sessionId, input.sessionMetadata);
            } else {
              lease.runtime.conversationStore.updateSessionMetadata(input.sessionId, input.sessionMetadata);
            }
          }
        }
      } finally {
        lease.release();
      }
    },
  });
  await botEngine.start();
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
    botEngine.close();
    await registry.closeAll();
    await options.saasMemoryRuntime?.close();
    await options.saasConversationRuntime?.close();
    wsTickets.close();
    if (options.controlRuntime) {
      await options.controlRuntime.close();
    } else {
      await widgetCredentials.close();
      widgetCredentialStore?.close();
      await controlPlane.close();
      if (!(controlPlane instanceof SqliteControlPlaneAdapter && controlPlane.ownsStore)) controlStore?.close();
    }
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
  });
  await registerSharedBusinessRoutes(app, {
    registry,
    identityProvider: routedIdentityProvider,
    botRepository,
    widgetCredentialStore: widgetCredentials,
    wsTickets,
    registerPublicAgui: !widgetIdentityProvider,
    ...(resolveMemoryApplication ? { resolveMemoryApplication } : {}),
    ...(options.resolveKnowledgeFileStore ? { resolveKnowledgeFileStore: options.resolveKnowledgeFileStore } : {}),
    ...(options.resolveSessionFileStorage ? { resolveSessionFileStorage: options.resolveSessionFileStorage } : {}),
    ...(options.resolveFileHistoryStorage ? { resolveFileHistoryStorage: options.resolveFileHistoryStorage } : {}),
    ...(options.resolveKnowledgeMarkdownPipeline ? { resolveKnowledgeMarkdownPipeline: options.resolveKnowledgeMarkdownPipeline } : {}),
    ...(options.resolveKnowledgeVectorApplication ? { resolveKnowledgeVectorApplication: options.resolveKnowledgeVectorApplication } : {}),
    ...(options.resolveProviderMcp ? { resolveProviderMcp: options.resolveProviderMcp } : {}),
    ...(options.resolveSessionApplication ? { resolveSessionApplication: options.resolveSessionApplication } : {}),
    ...(options.resolveExecutionRead ? { resolveExecutionRead: options.resolveExecutionRead } : {}),
    ...(options.resolveInteractionRecovery ? { resolveInteractionRecovery: options.resolveInteractionRecovery } : {}),
    ...(options.resolveAnalytics ? { resolveAnalytics: options.resolveAnalytics } : {}),
    ...(options.resolveMonitoringApplication ? { resolveMonitoringApplication: options.resolveMonitoringApplication } : {}),
    ...(options.resolveArtifactApplication ? { resolveArtifactApplication: options.resolveArtifactApplication } : {}),
    ...(widgetAuth ? { widgetAuth } : {}),
  });
  await registerManagementAndPlatformRoutes(app, {
    controlPlane,
    registry,
    identityProvider: routedIdentityProvider,
    botRepository,
    widgetCredentialStore: widgetCredentials,
    ...(widgetAuth ? { widgetAuth } : {}),
    ...(options.resolveExecutionRead ? { resolveExecutionRead: options.resolveExecutionRead } : {}),
  });
  await registerWidgetAndRealtimeRoutes(app, {
    registry,
    identityProvider: routedIdentityProvider,
    botRepository,
    widgetCredentialStore: widgetCredentials,
    wsTickets,
    ...(widgetIdentityProvider ? { widgetIdentityProvider } : {}),
    ...(widgetAuth ? { widgetAuth } : {}),
    ...(options.resolveSessionApplication ? { resolveSessionApplication: options.resolveSessionApplication } : {}),
  });

  registerFrontendFallback(app);

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

function createIdentityProvider(
  authMode: string,
  controlPlane: ControlPlane,
  sessionTokens: SessionTokenService | undefined,
): IdentityProvider {
  if (authMode === "local") return new LocalIdentityProvider(controlPlane);
  if (authMode === "password" && sessionTokens) return new PasswordIdentityProvider(controlPlane, sessionTokens);
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

