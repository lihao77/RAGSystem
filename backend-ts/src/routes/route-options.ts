import type { FastifyRequest } from "fastify";

import type { WidgetCredentialRepository } from "../contracts/widget-credentials.js";
import type { BotRepository } from "../contracts/bot-repository.js";
import type { IdentityProvider } from "../services/identity/index.js";
import type { MemoryApplication } from "../services/memory/index.js";
import type { AsyncKnowledgeFileStore } from "../contracts/knowledge/async-knowledge-file-store.js";
import type { AsyncKnowledgeMarkdownPipeline } from "../contracts/knowledge/async-knowledge-markdown-pipeline.js";
import type { WidgetAuthService } from "../services/runtime/jwt-service.js";
import type { TenantRuntimeRegistry } from "../services/runtime/tenant-runtime-registry.js";
import type { WsTicketService } from "../services/runtime/ws-ticket-service.js";
import type { SaaSProviderMcpApplication } from "../services/runtime/saas-provider-mcp-application.js";
import type { SaaSKnowledgeVectorApplication } from "../services/runtime/saas-knowledge-vector-application.js";
import type { SaaSSessionApplication } from "../services/runtime/saas-session-application.js";
import type { SaaSAgentReadApplication } from "../services/runtime/saas-agent-read-application.js";
import type { SaaSInteractionRecoveryApplication } from "../services/runtime/saas-interaction-recovery-application.js";
import type { SaaSAnalyticsApplication } from "../services/runtime/saas-analytics-application.js";
import type { SaaSMonitoringApplication } from "../services/runtime/saas-monitoring-application.js";
import type { AsyncSessionFileStorage } from "../contracts/session-file-storage.js";

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
  resolveSaaSSessionApplication?: (request: FastifyRequest) => SaaSSessionApplication | undefined | Promise<SaaSSessionApplication | undefined>;
  resolveSaaSAgentReadApplication?: (request: FastifyRequest) => SaaSAgentReadApplication | undefined | Promise<SaaSAgentReadApplication | undefined>;
  resolveSaaSInteractionRecovery?: (request: FastifyRequest) => SaaSInteractionRecoveryApplication | undefined | Promise<SaaSInteractionRecoveryApplication | undefined>;
  resolveSaaSAnalytics?: (request: FastifyRequest) => SaaSAnalyticsApplication | undefined | Promise<SaaSAnalyticsApplication | undefined>;
  resolveSaaSMonitoringApplication?: (request: FastifyRequest) => SaaSMonitoringApplication | undefined | Promise<SaaSMonitoringApplication | undefined>;
  resolveSessionFileStorage?: (request: FastifyRequest) => AsyncSessionFileStorage | undefined | Promise<AsyncSessionFileStorage | undefined>;
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
