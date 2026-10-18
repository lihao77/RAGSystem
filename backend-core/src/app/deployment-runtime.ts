import type { FastifyBaseLogger } from "fastify";

import type { ControlPlane } from "../contracts/control-plane/index.js";
import type { RouteOptions } from "../routes/route-options.js";
import type { IdentityProvider } from "../services/identity/index.js";
import type { RuntimeContainerRegistry } from "../services/runtime/runtime-container-registry.js";
import type { WsTicketService } from "../services/runtime/ws-ticket-service.js";
import type { BackendPluginResourceContribution, BackendRuntimeContributions } from "../plugins/backend-plugin.js";
import type { EntityLifecyclePublisher } from "../contracts/runtime/entity-lifecycle-events.js";
import type { DeploymentProfile } from "../identity/types.js";

export interface DeploymentApplicationResolvers {
  resolveProviderApplication: NonNullable<RouteOptions["resolveProviderApplication"]>;
  resolveSessionApplication: NonNullable<RouteOptions["resolveSessionApplication"]>;
  resolveExecutionRead: NonNullable<RouteOptions["resolveExecutionRead"]>;
  resolveExecutionApplication: NonNullable<RouteOptions["resolveExecutionApplication"]>;
  resolveAnalytics: NonNullable<RouteOptions["resolveAnalytics"]>;
  resolveMonitoringApplication: NonNullable<RouteOptions["resolveMonitoringApplication"]>;
  resolveSessionFileApplication: NonNullable<RouteOptions["resolveSessionFileApplication"]>;
  resolveFileChangeApplication: NonNullable<RouteOptions["resolveFileChangeApplication"]>;
  resolveWorkspaceFileApplication: NonNullable<RouteOptions["resolveWorkspaceFileApplication"]>;
}

/**
 * Complete deployment composition consumed by the shared HTTP application.
 * Implementations belong to backend-local; core code must not
 * inspect storage modes or instantiate infrastructure adapters.
 */
/** 宿主提供给部署组合的服务：领域服务经此发布实体生命周期事件到插件总线。 */
export interface DeploymentHostServices {
  emitLifecycleEvent: EntityLifecyclePublisher;
}

export interface DeploymentRuntime {
  readonly controlPlane: ControlPlane;
  readonly applications: DeploymentApplicationResolvers;
  readonly wsTickets: WsTicketService;
  readonly hostResources?: readonly BackendPluginResourceContribution[];
  validateProfile?(profile: DeploymentProfile): void;
  createRegistry(
    logger: FastifyBaseLogger,
    plugins?: BackendRuntimeContributions,
    host?: DeploymentHostServices,
  ): RuntimeContainerRegistry | Promise<RuntimeContainerRegistry>;
  createIdentityProvider(
    authMode: string,
  ): IdentityProvider | Promise<IdentityProvider>;
  close(): Promise<void>;
}
