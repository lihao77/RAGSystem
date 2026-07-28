import type { FastifyRequest } from "fastify";
import type { AsyncSessionFileStorage } from "../contracts/session/session-file-storage.js";
import type { AsyncFileHistoryStore } from "../contracts/file-history-store/index.js";

import type { WidgetCredentialRepository } from "../contracts/control-plane/widget-credentials.js";
import type { BotRepository } from "../contracts/control-plane/bot-repository.js";
import type { IdentityProvider } from "../services/identity/index.js";
import type { WidgetAuthService } from "../services/runtime/jwt-service.js";
import type { RuntimeContainerRegistry as TenantRuntimeRegistry } from "../services/runtime/runtime-container-registry.js";
import type { WsTicketService } from "../services/runtime/ws-ticket-service.js";
import type { ProviderApplication } from "../contracts/application/provider-application.js";
import type { SessionApplication } from "../contracts/session/session-application.js";
import type { AnalyticsApplication } from "../contracts/application/analytics-application.js";
import type { MonitoringApplication } from "../contracts/application/monitoring-application.js";
import type { ExecutionApplication } from "../contracts/execution/execution-application.js";
import type { SessionFileApplication } from "../contracts/application/session-file-application.js";
import type { FileChangeApplication } from "../contracts/application/file-change-application.js";

export interface RouteOptions {
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  resolveProviderApplication?: (request: FastifyRequest) => ProviderApplication | undefined | Promise<ProviderApplication | undefined>;
  resolveSessionApplication?: (request: FastifyRequest) => SessionApplication | undefined | Promise<SessionApplication | undefined>;
  resolveExecutionRead?: (request: FastifyRequest) => import("../contracts/execution/execution-read-application.js").ExecutionReadApplication | undefined | Promise<import("../contracts/execution/execution-read-application.js").ExecutionReadApplication | undefined>;
  resolveExecutionApplication?: (request: FastifyRequest) => ExecutionApplication | undefined | Promise<ExecutionApplication | undefined>;
  resolveAnalytics?: (request: FastifyRequest) => AnalyticsApplication | undefined | Promise<AnalyticsApplication | undefined>;
  resolveMonitoringApplication?: (request: FastifyRequest) => MonitoringApplication | undefined | Promise<MonitoringApplication | undefined>;
  resolveSessionFileStorage?: (request: FastifyRequest) => AsyncSessionFileStorage | undefined | Promise<AsyncSessionFileStorage | undefined>;
  resolveFileHistoryStorage?: (request: FastifyRequest) => AsyncFileHistoryStore | undefined | Promise<AsyncFileHistoryStore | undefined>;
  resolveSessionFileApplication?: (request: FastifyRequest) => SessionFileApplication | undefined | Promise<SessionFileApplication | undefined>;
  resolveFileChangeApplication?: (request: FastifyRequest) => FileChangeApplication | undefined | Promise<FileChangeApplication | undefined>;
  widgetCredentialStore?: WidgetCredentialRepository;
  widgetAuth?: WidgetAuthService;
}

export interface AgentRouteOptions extends RouteOptions {
  botRepository: BotRepository;
  wsTickets: WsTicketService;
}
