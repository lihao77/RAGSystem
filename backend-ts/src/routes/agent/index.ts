import type { FastifyPluginAsync } from "fastify";

import type { RouteOptions } from "../route-options.js";
import { registerAgentManagementRoutes } from "./agents.js";
import { registerAnalyticsRoutes } from "./analytics.js";
import { registerExecutionRoutes } from "./execution.js";
import { registerMonitoringRoutes } from "./monitoring.js";
import { registerRuntimeCoreRoutes } from "./runtime-core.js";
import { registerSessionFileRoutes } from "./session-files.js";
import { registerSessionRoutes } from "./sessions.js";
import { registerStreamRoutes } from "./stream.js";
import { registerSessionWebSocketRoute } from "./ws.js";

export const registerAgentRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  await app.register(registerAgentManagementRoutes, { container: options.container });
  await app.register(registerExecutionRoutes, { container: options.container });
  await app.register(registerMonitoringRoutes, { container: options.container });
  await app.register(registerAnalyticsRoutes, { container: options.container });
  await app.register(registerRuntimeCoreRoutes, { container: options.container });
  await app.register(registerStreamRoutes, { container: options.container });
  await app.register(registerSessionFileRoutes, { container: options.container });
  await app.register(registerSessionRoutes, { container: options.container });
  await app.register(registerSessionWebSocketRoute, { container: options.container });
};
