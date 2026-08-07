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
import { registerWorkspaceFileRoutes } from "./workspace-files.js";

export const registerAgentRoutes: FastifyPluginAsync<AgentRouteOptions> = async (app, options) => {
  const routeOptions: AgentRouteOptions = {
    registry: options.registry,
    identityProvider: options.identityProvider,
    wsTickets: options.wsTickets,
    ...(options.emitPluginEvent ? { emitPluginEvent: options.emitPluginEvent } : {}),
    ...(options.resolveSessionApplication ? { resolveSessionApplication: options.resolveSessionApplication } : {}),
    ...(options.resolveExecutionRead ? { resolveExecutionRead: options.resolveExecutionRead } : {}),
    ...(options.resolveExecutionApplication ? { resolveExecutionApplication: options.resolveExecutionApplication } : {}),
    ...(options.resolveAnalytics ? { resolveAnalytics: options.resolveAnalytics } : {}),
    ...(options.resolveMonitoringApplication ? { resolveMonitoringApplication: options.resolveMonitoringApplication } : {}),
    ...(options.resolveSessionFileApplication ? { resolveSessionFileApplication: options.resolveSessionFileApplication } : {}),
    ...(options.resolveFileChangeApplication ? { resolveFileChangeApplication: options.resolveFileChangeApplication } : {}),
    ...(options.resolveWorkspaceFileApplication ? { resolveWorkspaceFileApplication: options.resolveWorkspaceFileApplication } : {}),
  };
  await app.register(registerAgentManagementRoutes, routeOptions);
  await app.register(registerExecutionRoutes, routeOptions);
  await app.register(registerMonitoringRoutes, routeOptions);
  await app.register(registerAnalyticsRoutes, routeOptions);
  await app.register(registerRuntimeCoreRoutes, routeOptions);
  await app.register(registerStreamRoutes, routeOptions);
  await app.register(registerSessionFileRoutes, routeOptions);
  await app.register(registerFileChangeRoutes, routeOptions);
  await app.register(registerWorkspaceFileRoutes, routeOptions);
  await app.register(registerSessionRoutes, routeOptions);
};
