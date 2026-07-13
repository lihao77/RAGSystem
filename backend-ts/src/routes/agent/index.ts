import type { FastifyPluginAsync } from "fastify";

import type { RouteOptions } from "../route-options.js";
import { registerAgentManagementRoutes } from "./agents.js";
import { registerAnalyticsRoutes } from "./analytics.js";
import { registerExecutionRoutes } from "./execution.js";
import { registerMonitoringRoutes } from "./monitoring.js";
import { registerRuntimeCoreRoutes } from "./runtime-core.js";
import { registerFileChangeRoutes } from "./file-changes.js";
import { registerSessionFileRoutes } from "./session-files.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerStreamRoutes } from "./stream.js";
import { registerSessionWebSocketRoute } from "./ws.js";

export const registerAgentRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  const routeOptions: RouteOptions = {
    registry: options.registry,
    identityProvider: options.identityProvider,
    ...(options.widgetCredentialStore ? { widgetCredentialStore: options.widgetCredentialStore } : {}),
    ...(options.widgetAuth ? { widgetAuth: options.widgetAuth } : {}),
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
  await app.register(registerSessionWebSocketRoute, routeOptions);
};
