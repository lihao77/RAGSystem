import type { FastifyRequest } from "fastify";

import type { WidgetCredentialRepository } from "../contracts/widget-credentials.js";
import type { BotRepository } from "../contracts/bot-repository.js";
import type { IdentityProvider } from "../services/identity/index.js";
import type { MemoryApplication } from "../services/memory/index.js";
import type { AsyncKnowledgeFileStore } from "../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { WidgetAuthService } from "../services/runtime/jwt-service.js";
import type { TenantRuntimeRegistry } from "../adapters/local/tenant-runtime-registry.js";
import type { WsTicketService } from "../services/runtime/ws-ticket-service.js";
import type { SaaSProviderMcpApplication } from "../adapters/saas/application/provider-mcp/saas-provider-mcp-application.js";
import type { SaaSKnowledgeVectorApplication } from "../adapters/saas/application/knowledge/saas-knowledge-vector-application.js";
import type { SessionApplication } from "../contracts/session/session-application.js";
import type { InteractionRecoveryApplication } from "../contracts/interaction-recovery-application.js";
import type { AnalyticsApplication } from "../contracts/analytics-application.js";
import type { MonitoringApplication } from "../contracts/monitoring-application.js";
import type { AsyncSessionFileStorage } from "../contracts/session/session-file-storage.js";
import type { ArtifactApplication } from "../contracts/artifact-application.js";
import type { AsyncFileHistoryStore } from "../contracts/file-history-store/index.js";

export interface RouteOptions {
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  resolveMemoryApplication?: (
    request: FastifyRequest,
  ) => MemoryApplication | undefined | Promise<MemoryApplication | undefined>;
  /** Optional tenant-bound SaaS knowledge file store. Local routes use the runtime container store. */
  resolveKnowledgeFileStore?: (
    request: FastifyRequest,
  ) => AsyncKnowledgeFileStore | undefined | Promise<AsyncKnowledgeFileStore | undefined>;
  resolveKnowledgeMarkdownPipeline?: (
    request: FastifyRequest,
  ) => AsyncKnowledgeMarkdownPipeline | undefined | Promise<AsyncKnowledgeMarkdownPipeline | undefined>;
  resolveKnowledgeVectorApplication?: (request: FastifyRequest) => SaaSKnowledgeVectorApplication | undefined | Promise<SaaSKnowledgeVectorApplication | undefined>;
  resolveProviderMcp?: (request: FastifyRequest) => SaaSProviderMcpApplication | undefined | Promise<SaaSProviderMcpApplication | undefined>;
  resolveSessionApplication?: (request: FastifyRequest) => SessionApplication | undefined | Promise<SessionApplication | undefined>;
  resolveExecutionRead?: (request: FastifyRequest) => import("../contracts/execution/execution-read-application.js").ExecutionReadApplication | undefined | Promise<import("../contracts/execution/execution-read-application.js").ExecutionReadApplication | undefined>;
  resolveInteractionRecovery?: (request: FastifyRequest) => InteractionRecoveryApplication | undefined | Promise<InteractionRecoveryApplication | undefined>;
  resolveAnalytics?: (request: FastifyRequest) => AnalyticsApplication | undefined | Promise<AnalyticsApplication | undefined>;
  resolveMonitoringApplication?: (request: FastifyRequest) => MonitoringApplication | undefined | Promise<MonitoringApplication | undefined>;
  resolveSessionFileStorage?: (request: FastifyRequest) => AsyncSessionFileStorage | undefined | Promise<AsyncSessionFileStorage | undefined>;
  resolveFileHistoryStorage?: (request: FastifyRequest) => AsyncFileHistoryStore | undefined | Promise<AsyncFileHistoryStore | undefined>;
  resolveArtifactApplication?: (request: FastifyRequest) => ArtifactApplication | Promise<ArtifactApplication>;
  widgetCredentialStore?: WidgetCredentialRepository;
  widgetAuth?: WidgetAuthService;
}

export interface BotRouteOptions extends RouteOptions {
  botRepository: BotRepository;
}

export interface AgentRouteOptions extends RouteOptions {
  botRepository: BotRepository;
  wsTickets: WsTicketService;
}
