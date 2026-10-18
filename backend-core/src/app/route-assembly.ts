import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AppEnv } from "../config/env.js";
import type {
  BackendPluginEventPublisher,
  BackendRouteContribution,
  BackendRouteHostContext,
  BackendRouteInstallContext,
  BackendRouteScope,
} from "../plugins/backend-plugin.js";
import type { ControlPlane } from "../contracts/control-plane/index.js";
import type { DeploymentProfile } from "../identity/types.js";
import { registerAgentConfigRoutes } from "../routes/agent-config.js";
import { registerAguiRoutes } from "../routes/agent/agui.js";
import { registerAgentRoutes } from "../routes/agent/index.js";
import { registerSessionWebSocketRoute } from "../routes/agent/ws.js";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerBootstrapRoutes } from "../routes/bootstrap.js";
import { registerHealthRoutes, registerProbeRoutes } from "../routes/health.js";
import { registerModelAdapterRoutes } from "../routes/model-adapter.js";
import { registerPublicPluginUiManifestRoutes, registerTenantPluginRoutes, type PluginListingOptions } from "../routes/plugins.js";
import { registerSystemConfigRoutes } from "../routes/system-config.js";
import type { RouteOptions } from "../routes/route-options.js";
import { AuthError, type IdentityProvider } from "../services/identity/index.js";
import type { RuntimeContainerRegistry as TenantRuntimeRegistry } from "../services/runtime/runtime-container-registry.js";
import type { WsTicketService } from "../services/runtime/ws-ticket-service.js";
import { HttpError } from "../utils/errors.js";
import { createRequestApplications } from "./request-applications.js";

export interface AuthRuntime {
  profile: DeploymentProfile;
  identityProvider: IdentityProvider;
}

interface PublicRouteAssemblyOptions {
  env: AppEnv;
  controlPlane: ControlPlane;
  runtime: AuthRuntime;
  pluginRoutes?: readonly BackendRouteContribution[];
  emitPluginEvent?: (event: string, payload: unknown) => Promise<void>;
  pluginRouteHost?: BackendRouteHostContext;
  pluginListing?: PluginListingOptions;
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
  await app.register(registerAuthRoutes, {
    prefix: "/api/auth",
    identityProvider: options.runtime.identityProvider,
  });
  await registerPluginRoutes(app, options.pluginRoutes, "public", {
    emitPluginEvent: options.emitPluginEvent,
    host: options.pluginRouteHost,
  });
  await app.register(registerPublicPluginUiManifestRoutes, {
    prefix: "/api",
    ...(options.pluginListing ?? { listPlugins: () => [], listUi: () => [] }),
  });
}

export interface SharedBusinessRouteAssemblyOptions {
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  wsTickets: WsTicketService;
  registerPublicAgui: boolean;
  resolveProviderApplication: NonNullable<RouteOptions["resolveProviderApplication"]>;
  resolveSessionApplication: NonNullable<RouteOptions["resolveSessionApplication"]>;
  resolveExecutionRead: NonNullable<RouteOptions["resolveExecutionRead"]>;
  resolveExecutionApplication: NonNullable<RouteOptions["resolveExecutionApplication"]>;
  resolveAnalytics: NonNullable<RouteOptions["resolveAnalytics"]>;
  resolveMonitoringApplication: NonNullable<RouteOptions["resolveMonitoringApplication"]>;
  resolveSessionFileApplication: NonNullable<RouteOptions["resolveSessionFileApplication"]>;
  resolveFileChangeApplication: NonNullable<RouteOptions["resolveFileChangeApplication"]>;
  resolveWorkspaceFileApplication: NonNullable<RouteOptions["resolveWorkspaceFileApplication"]>;
  pluginRoutes?: readonly BackendRouteContribution[];
  emitPluginEvent?: (event: string, payload: unknown) => Promise<void>;
  pluginRouteHost?: BackendRouteHostContext;
  pluginListing?: PluginListingOptions;
}

export async function registerSharedBusinessRoutes(
  app: FastifyInstance,
  options: SharedBusinessRouteAssemblyOptions,
): Promise<void> {
  await app.register(async (scope) => {
    installIdentityScope(scope, { identityProvider: options.identityProvider, registry: options.registry });
    const routeOptions = {
      registry: options.registry,
      identityProvider: options.identityProvider,
      ...(options.emitPluginEvent ? { emitPluginEvent: options.emitPluginEvent } : {}),
      resolveSessionApplication: options.resolveSessionApplication,
      resolveAnalytics: options.resolveAnalytics,
      resolveMonitoringApplication: options.resolveMonitoringApplication,
      resolveExecutionRead: options.resolveExecutionRead,
      resolveExecutionApplication: options.resolveExecutionApplication,
      resolveProviderApplication: options.resolveProviderApplication,
    };
    scope.addHook("preHandler", async (request) => {
      if (isExplicitPublicRoute(request)) return;
      request.applications = await createRequestApplications(request, routeOptions);
    });
    await scope.register(registerHealthRoutes, { prefix: "/api", ...routeOptions });
    await scope.register(registerAgentConfigRoutes, { prefix: "/api/agent-config", ...routeOptions });
    await scope.register(registerModelAdapterRoutes, { prefix: "/api/model-adapter", ...routeOptions });
    await scope.register(registerSystemConfigRoutes, { prefix: "/api/system-config", ...routeOptions });
    await scope.register(registerAgentRoutes, {
      prefix: "/api/agent",
      ...routeOptions,
      wsTickets: options.wsTickets,
      resolveSessionFileApplication: options.resolveSessionFileApplication,
      resolveFileChangeApplication: options.resolveFileChangeApplication,
      resolveWorkspaceFileApplication: options.resolveWorkspaceFileApplication,
    });
    if (options.registerPublicAgui) {
      await scope.register(registerAguiRoutes, {
        prefix: "/api/agui",
        ...routeOptions,
      });
    }
    await registerPluginRoutes(scope, options.pluginRoutes, "tenant", {
      emitPluginEvent: options.emitPluginEvent,
      host: options.pluginRouteHost,
    });
    await scope.register(registerTenantPluginRoutes, {
      prefix: "/api/plugins",
      ...(options.pluginListing ?? { listPlugins: () => [], listUi: () => [] }),
    });
  });
}

interface ManagementRouteAssemblyOptions {
  controlPlane: ControlPlane;
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  pluginRoutes?: readonly BackendRouteContribution[];
  emitPluginEvent?: (event: string, payload: unknown) => Promise<void>;
  pluginRouteHost?: BackendRouteHostContext;
}

export async function registerManagementAndPlatformRoutes(
  app: FastifyInstance,
  options: ManagementRouteAssemblyOptions,
): Promise<void> {
  await app.register(async (scope) => {
    installIdentityScope(scope, { identityProvider: options.identityProvider });
    await registerPluginRoutes(scope, options.pluginRoutes, "management", {
      emitPluginEvent: options.emitPluginEvent,
      host: options.pluginRouteHost,
    });
  });
  await app.register(async (scope) => {
    installIdentityScope(scope, { identityProvider: options.identityProvider, identityScope: "platform" });
    await registerPluginRoutes(scope, options.pluginRoutes, "platform", {
      emitPluginEvent: options.emitPluginEvent,
      host: options.pluginRouteHost,
    });
  });
}

interface RealtimeRouteAssemblyOptions {
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  wsTickets: WsTicketService;
  resolveSessionApplication: NonNullable<RouteOptions["resolveSessionApplication"]>;
  resolveExecutionRead: NonNullable<RouteOptions["resolveExecutionRead"]>;
  resolveExecutionApplication: NonNullable<RouteOptions["resolveExecutionApplication"]>;
  resolveAnalytics: NonNullable<RouteOptions["resolveAnalytics"]>;
  resolveMonitoringApplication: NonNullable<RouteOptions["resolveMonitoringApplication"]>;
  resolveProviderApplication: NonNullable<RouteOptions["resolveProviderApplication"]>;
}

export async function registerRealtimeRoutes(
  app: FastifyInstance,
  options: RealtimeRouteAssemblyOptions,
): Promise<void> {
  const applicationResolvers = {
    resolveSessionApplication: options.resolveSessionApplication,
    resolveExecutionRead: options.resolveExecutionRead,
    resolveExecutionApplication: options.resolveExecutionApplication,
    resolveAnalytics: options.resolveAnalytics,
    resolveMonitoringApplication: options.resolveMonitoringApplication,
    resolveProviderApplication: options.resolveProviderApplication,
  };
  await app.register(registerSessionWebSocketRoute, {
    prefix: "/api/agent",
    registry: options.registry,
    identityProvider: options.identityProvider,
    wsTickets: options.wsTickets,
    ...applicationResolvers,
  });
}

async function registerPluginRoutes(
  app: FastifyInstance,
  contributions: readonly BackendRouteContribution[] | undefined,
  scope: BackendRouteScope,
  extras: {
    emitPluginEvent?: BackendPluginEventPublisher | undefined;
    host?: BackendRouteHostContext | undefined;
  } = {},
): Promise<void> {
  for (const contribution of contributions ?? []) {
    if (contribution.scope !== scope) continue;
    const installContext: BackendRouteInstallContext = {
      ...(extras.emitPluginEvent ? { emitPluginEvent: extras.emitPluginEvent } : {}),
      ...(extras.host ? { host: extras.host } : {}),
    };
    await app.register(async (pluginScope) => contribution.install(
      pluginScope,
      installContext,
    ), {
      prefix: contribution.prefix,
    });
  }
}

export interface IdentityScopeOptions {
  identityProvider: IdentityProvider;
  registry?: TenantRuntimeRegistry;
  mapAllIdentityErrorsToUnauthorized?: boolean;
  identityScope?: "tenant" | "platform";
}

export function installIdentityScope(app: FastifyInstance, options: IdentityScopeOptions): void {
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
