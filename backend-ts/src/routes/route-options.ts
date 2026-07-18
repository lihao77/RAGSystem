import type { FastifyRequest } from "fastify";

import type { IdentityProvider } from "../services/identity/index.js";
import type { MemoryApplication } from "../services/memory/index.js";
import type { WidgetAuthService } from "../services/runtime/jwt-service.js";
import type { TenantRuntimeRegistry } from "../services/runtime/tenant-runtime-registry.js";
import type { WidgetCredentialStore } from "../services/stores/widget-credential-store/index.js";
import type { WsTicketService } from "../services/runtime/ws-ticket-service.js";

export interface RouteOptions {
  registry: TenantRuntimeRegistry;
  identityProvider: IdentityProvider;
  resolveMemoryApplication?: (
    request: FastifyRequest,
  ) => MemoryApplication | undefined | Promise<MemoryApplication | undefined>;
  widgetCredentialStore?: WidgetCredentialStore;
  widgetAuth?: WidgetAuthService;
}

export interface AgentRouteOptions extends RouteOptions {
  wsTickets: WsTicketService;
}
