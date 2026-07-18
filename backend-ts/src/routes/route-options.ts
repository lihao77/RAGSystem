import type { FastifyRequest } from "fastify";

import type { WidgetCredentialRepository } from "../contracts/widget-credentials.js";
import type { BotRepository } from "../contracts/bot-repository.js";
import type { IdentityProvider } from "../services/identity/index.js";
import type { MemoryApplication } from "../services/memory/index.js";
import type { WidgetAuthService } from "../services/runtime/jwt-service.js";
import type { TenantRuntimeRegistry } from "../services/runtime/tenant-runtime-registry.js";
import type { WsTicketService } from "../services/runtime/ws-ticket-service.js";

export interface RouteOptions {
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  resolveMemoryApplication?: (
    request: FastifyRequest,
  ) => MemoryApplication | undefined | Promise<MemoryApplication | undefined>;
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
