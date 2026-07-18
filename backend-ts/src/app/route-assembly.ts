import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AppEnv } from "../config/env.js";
import type { ControlPlane } from "../contracts/control-plane/index.js";
import type { DeploymentProfile } from "../identity/types.js";
import { registerAdminRoutes } from "../routes/admin.js";
import { registerAgentConfigRoutes } from "../routes/agent-config.js";
import { registerAguiRoutes } from "../routes/agent/agui.js";
import { registerAgentRoutes } from "../routes/agent/index.js";
import { registerSessionWebSocketRoute } from "../routes/agent/ws.js";
import { registerArtifactRoutes } from "../routes/artifacts.js";
import { registerAuthRoutes, registerInstallRoutes } from "../routes/auth.js";
import { registerBootstrapRoutes } from "../routes/bootstrap.js";
import { registerBotRoutes } from "../routes/bots.js";
import { registerEmbeddingModelRoutes } from "../routes/embedding-models.js";
import { registerHealthRoutes, registerProbeRoutes } from "../routes/health.js";
import { registerKnowledgeBaseRoutes } from "../routes/knowledge-base.js";
import { registerMcpRoutes } from "../routes/mcp.js";
import { registerMemoryRoutes } from "../routes/memory.js";
import { registerModelAdapterRoutes } from "../routes/model-adapter.js";
import { registerPlatformRoutes } from "../routes/platform.js";
import { registerSkillRoutes } from "../routes/skills.js";
import { registerSystemConfigRoutes } from "../routes/system-config.js";
import { registerWidgetAppsRoutes } from "../routes/widget-apps.js";
import { registerWidgetRoutes } from "../routes/widget.js";
import type { RouteOptions } from "../routes/route-options.js";
import { AuthError, type IdentityProvider } from "../services/identity/index.js";
import type { WidgetAuthService } from "../services/runtime/jwt-service.js";
import type { SessionTokenService } from "../services/runtime/session-token-service.js";
import type { TenantRuntimeRegistry } from "../services/runtime/tenant-runtime-registry.js";
import type { WsTicketService } from "../services/runtime/ws-ticket-service.js";
import type { WidgetCredentialStore } from "../services/stores/widget-credential-store/index.js";
import { HttpError } from "../utils/errors.js";

export interface AuthRuntime {
  profile: DeploymentProfile;
  sessionTokens: SessionTokenService | undefined;
  identityProvider: IdentityProvider;
}

interface PublicRouteAssemblyOptions {
  env: AppEnv;
  controlPlane: ControlPlane;
  runtime: AuthRuntime;
  refreshProfile: () => Promise<DeploymentProfile>;
  validateProfileSettings: (settings: Readonly<Record<string, string>>) => void;
}

export async function registerPublicAndAuthRoutes(
  app: FastifyInstance,
  options: PublicRouteAssemblyOptions,
): Promise<void> {
  await app.register(registerProbeRoutes, { controlPlane: options.controlPlane });
  await app.register(registerBootstrapRoutes, {
    prefix: "/api",
    env: options.env,
    controlPlane: options.controlPlane,
    runtime: options.runtime,
  });
  await app.register(registerInstallRoutes, {
    prefix: "/api",
    controlPlane: options.controlPlane,
    runtime: options.runtime,
    refreshProfile: options.refreshProfile,
    validateProfileSettings: options.validateProfileSettings,
  });
  await app.register(registerAuthRoutes, {
    prefix: "/api/auth",
    controlPlane: options.controlPlane,
    runtime: options.runtime,
  });
}

export interface SharedBusinessRouteAssemblyOptions {
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  widgetCredentialStore: WidgetCredentialStore;
  widgetAuth?: WidgetAuthService;
  wsTickets: WsTicketService;
  registerPublicAgui: boolean;
  resolveMemoryApplication?: RouteOptions["resolveMemoryApplication"];
}

export async function registerSharedBusinessRoutes(
  app: FastifyInstance,
  options: SharedBusinessRouteAssemblyOptions,
): Promise<void> {
  await app.register(async (scope) => {
    installIdentityScope(scope, { identityProvider: options.identityProvider, registry: options.registry });
    const routeOptions = { registry: options.registry, identityProvider: options.identityProvider };
    await scope.register(registerHealthRoutes, { prefix: "/api", ...routeOptions });
    await scope.register(registerArtifactRoutes, { prefix: "/api/artifacts", ...routeOptions });
    await scope.register(registerAgentConfigRoutes, { prefix: "/api/agent-config", ...routeOptions });
    await scope.register(registerMemoryRoutes, {
      prefix: "/api/memory",
      ...routeOptions,
      ...(options.resolveMemoryApplication
        ? { resolveMemoryApplication: options.resolveMemoryApplication }
        : {}),
    });
    await scope.register(registerSkillRoutes, { prefix: "/api/skills", ...routeOptions });
    await scope.register(registerModelAdapterRoutes, { prefix: "/api/model-adapter", ...routeOptions });
    await scope.register(registerSystemConfigRoutes, { prefix: "/api/system-config", ...routeOptions });
    await scope.register(registerMcpRoutes, { prefix: "/api/mcp", ...routeOptions });
    await scope.register(registerKnowledgeBaseRoutes, { prefix: "/api/knowledge-bases", ...routeOptions });
    await scope.register(registerEmbeddingModelRoutes, { prefix: "/api/embedding-models", ...routeOptions });
    await scope.register(registerAgentRoutes, {
      prefix: "/api/agent",
      ...routeOptions,
      widgetCredentialStore: options.widgetCredentialStore,
      wsTickets: options.wsTickets,
      ...(options.widgetAuth ? { widgetAuth: options.widgetAuth } : {}),
    });
    if (options.registerPublicAgui) {
      await scope.register(registerAguiRoutes, {
        prefix: "/api/agui",
        ...routeOptions,
        widgetCredentialStore: options.widgetCredentialStore,
      });
    }
  });
}

interface ManagementRouteAssemblyOptions {
  controlPlane: ControlPlane;
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  widgetCredentialStore: WidgetCredentialStore;
  widgetAuth?: WidgetAuthService;
}

export async function registerManagementAndPlatformRoutes(
  app: FastifyInstance,
  options: ManagementRouteAssemblyOptions,
): Promise<void> {
  await app.register(async (scope) => {
    installIdentityScope(scope, { identityProvider: options.identityProvider });
    await scope.register(registerAdminRoutes, { prefix: "/api/admin", controlPlane: options.controlPlane });
    await scope.register(registerBotRoutes, {
      prefix: "/api/bots",
      registry: options.registry,
      identityProvider: options.identityProvider,
    });
    await scope.register(registerWidgetAppsRoutes, {
      prefix: "/api/widget/apps",
      registry: options.registry,
      identityProvider: options.identityProvider,
      widgetCredentialStore: options.widgetCredentialStore,
      ...(options.widgetAuth ? { widgetAuth: options.widgetAuth } : {}),
    });
  });
  await app.register(async (scope) => {
    installIdentityScope(scope, { identityProvider: options.identityProvider, identityScope: "platform" });
    await scope.register(registerPlatformRoutes, {
      prefix: "/api/platform",
      controlPlane: options.controlPlane,
      registry: options.registry,
    });
  });
}

interface WidgetRouteAssemblyOptions {
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  widgetIdentityProvider?: IdentityProvider;
  widgetCredentialStore: WidgetCredentialStore;
  widgetAuth?: WidgetAuthService;
  wsTickets: WsTicketService;
}

export async function registerWidgetAndRealtimeRoutes(
  app: FastifyInstance,
  options: WidgetRouteAssemblyOptions,
): Promise<void> {
  if (options.widgetIdentityProvider && options.widgetAuth) {
    await app.register(async (scope) => {
      installIdentityScope(scope, {
        identityProvider: options.widgetIdentityProvider!,
        registry: options.registry,
        mapAllIdentityErrorsToUnauthorized: true,
      });
      await scope.register(registerAguiRoutes, {
        prefix: "/api/agui",
        registry: options.registry,
        identityProvider: options.identityProvider,
        widgetCredentialStore: options.widgetCredentialStore,
        widgetAuth: options.widgetAuth!,
      });
      await scope.register(registerWidgetRoutes, {
        prefix: "/api/widget",
        registry: options.registry,
        identityProvider: options.identityProvider,
        widgetCredentialStore: options.widgetCredentialStore,
        wsTickets: options.wsTickets,
        widgetAuth: options.widgetAuth!,
      });
    });
  } else {
    await app.register(registerWidgetRoutes, {
      prefix: "/api/widget",
      registry: options.registry,
      identityProvider: options.identityProvider,
      widgetCredentialStore: options.widgetCredentialStore,
      wsTickets: options.wsTickets,
    });
  }

  await app.register(registerSessionWebSocketRoute, {
    prefix: "/api/agent",
    registry: options.registry,
    identityProvider: options.identityProvider,
    widgetCredentialStore: options.widgetCredentialStore,
    wsTickets: options.wsTickets,
    ...(options.widgetAuth ? { widgetAuth: options.widgetAuth } : {}),
  });
}

interface IdentityScopeOptions {
  identityProvider: IdentityProvider;
  registry?: TenantRuntimeRegistry;
  mapAllIdentityErrorsToUnauthorized?: boolean;
  identityScope?: "tenant" | "platform";
}

function installIdentityScope(app: FastifyInstance, options: IdentityScopeOptions): void {
  app.addHook("onRequest", async (request) => {
    if (request.method === "OPTIONS" || isExplicitPublicRoute(request)) return;
    let identity;
    try {
      identity = await options.identityProvider.resolve(request, options.identityScope ?? "tenant");
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
