import type { FastifyPluginAsync } from "fastify";

import type { AgentRouteOptions, RouteOptions } from "../route-options.js";
import { registerAgentManagementRoutes } from "./agents.js";
import { registerAnalyticsRoutes } from "./analytics.js";
import { registerExecutionRoutes } from "./execution.js";
import { registerMonitoringRoutes } from "./monitoring.js";
import { registerRuntimeCoreRoutes } from "./runtime-core.js";
import { registerFileChangeRoutes } from "./file-changes.js";
import { registerSessionFileRoutes } from "./session-files.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerStreamRoutes } from "./stream.js";

export const registerAgentRoutes: FastifyPluginAsync<AgentRouteOptions> = async (app, options) => {
  const routeOptions: AgentRouteOptions = {
    registry: options.registry,
    identityProvider: options.identityProvider,
    botRepository: options.botRepository,
    wsTickets: options.wsTickets,
    ...(options.widgetCredentialStore ? { widgetCredentialStore: options.widgetCredentialStore } : {}),
    ...(options.widgetAuth ? { widgetAuth: options.widgetAuth } : {}),
    ...(options.resolveSessionApplication ? { resolveSessionApplication: options.resolveSessionApplication } : {}),
    ...(options.resolveExecutionRead ? { resolveExecutionRead: options.resolveExecutionRead } : {}),
    ...(options.resolveAnalytics ? { resolveAnalytics: options.resolveAnalytics } : {}),
    ...(options.resolveMonitoringApplication ? { resolveMonitoringApplication: options.resolveMonitoringApplication } : {}),
    ...(options.resolveSessionFileStorage ? { resolveSessionFileStorage: options.resolveSessionFileStorage } : {}),
    ...(options.resolveFileHistoryStorage ? { resolveFileHistoryStorage: options.resolveFileHistoryStorage } : {}),
  };
  await app.register(registerAgentManagementRoutes, routeOptions);
  await app.register(registerExecutionRoutes, routeOptions);
  await app.register(registerMonitoringRoutes, routeOptions);
  await app.register(registerAnalyticsRoutes, routeOptions);
  await app.register(registerRuntimeCoreRoutes, routeOptions);
  await app.register(registerStreamRoutes, routeOptions);
  await app.register(registerSessionFileRoutes, routeOptions);
  await app.register(registerFileChangeRoutes, routeOptions);
  await app.register(registerSessionRoutes, routeOptions);
};
