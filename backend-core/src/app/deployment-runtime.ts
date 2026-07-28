import type { FastifyBaseLogger } from "fastify";
import type { HookRegistry } from "@ragsystem/agent-sdk";

import type { BotRepository } from "../contracts/control-plane/bot-repository.js";
import type { ControlPlane } from "../contracts/control-plane/index.js";
import type { WidgetCredentialRepository } from "../contracts/control-plane/widget-credentials.js";
import type { DaemonLeaderLease } from "../contracts/runtime/daemon-leader-lease.js";
import type { RouteOptions } from "../routes/route-options.js";
import type { DaemonService } from "../services/daemon/daemon-service.js";
import type { IdentityProvider } from "../services/identity/index.js";
import type { WidgetAuthService } from "../services/runtime/jwt-service.js";
import type { RuntimeContainerRegistry } from "../services/runtime/runtime-container-registry.js";
import type { SessionTokenService } from "../services/runtime/session-token-service.js";
import type { WsTicketService } from "../services/runtime/ws-ticket-service.js";

export interface DeploymentApplicationResolvers {
  resolveMemoryApplication: NonNullable<RouteOptions["resolveMemoryApplication"]>;
  resolveKnowledgeApplication: NonNullable<RouteOptions["resolveKnowledgeApplication"]>;
  resolveProviderApplication: NonNullable<RouteOptions["resolveProviderApplication"]>;
  resolveMcpApplication: NonNullable<RouteOptions["resolveMcpApplication"]>;
  resolveSessionApplication: NonNullable<RouteOptions["resolveSessionApplication"]>;
  resolveExecutionRead: NonNullable<RouteOptions["resolveExecutionRead"]>;
  resolveExecutionApplication: NonNullable<RouteOptions["resolveExecutionApplication"]>;
  resolveAnalytics: NonNullable<RouteOptions["resolveAnalytics"]>;
  resolveMonitoringApplication: NonNullable<RouteOptions["resolveMonitoringApplication"]>;
  resolveArtifactApplication: NonNullable<RouteOptions["resolveArtifactApplication"]>;
  resolveSessionFileApplication: NonNullable<RouteOptions["resolveSessionFileApplication"]>;
  resolveFileChangeApplication: NonNullable<RouteOptions["resolveFileChangeApplication"]>;
}

/**
 * Complete deployment composition consumed by the shared HTTP application.
 * Implementations belong to backend-local or backend-saas; shared code must not
 * inspect storage modes or instantiate infrastructure adapters.
 */
export interface DeploymentRuntime {
  readonly controlPlane: ControlPlane;
  readonly botRepository: BotRepository;
  readonly widgetCredentials: WidgetCredentialRepository;
  readonly applications: DeploymentApplicationResolvers;
  readonly wsTickets: WsTicketService;
  readonly initialSessionTokens?: SessionTokenService;
  readonly widgetAuth?: WidgetAuthService;
  readonly botEngine?: DaemonService;
  readonly daemonLeaderLease?: DaemonLeaderLease;
  createRegistry(
    logger: FastifyBaseLogger,
    configureHooks?: (registry: HookRegistry) => void,
  ): RuntimeContainerRegistry | Promise<RuntimeContainerRegistry>;
  createIdentityProvider(
    authMode: string,
    sessionTokens: SessionTokenService | undefined,
  ): IdentityProvider | Promise<IdentityProvider>;
  close(): Promise<void>;
}
