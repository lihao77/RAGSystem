import type { FastifyRequest } from "fastify";

import type { AnalyticsApplication } from "../contracts/application/analytics-application.js";
import type { MonitoringApplication } from "../contracts/application/monitoring-application.js";
import type { SessionApplication } from "../contracts/session/session-application.js";
import type { ExecutionReadApplication } from "../contracts/execution/execution-read-application.js";
import type { InteractionCoordinator } from "../contracts/runtime/pending-interactions.js";
import type { ExecutionApplication } from "../contracts/execution/execution-application.js";
import type { RouteOptions } from "../routes/route-options.js";
import type { ProviderApplication } from "../contracts/application/provider-application.js";

export interface RequestApplications {
  sessions: SessionApplication;
  analytics: AnalyticsApplication;
  monitoring: MonitoringApplication;
  executionRead: ExecutionReadApplication;
  interactions: InteractionCoordinator;
  execution: ExecutionApplication;
  providers: ProviderApplication;
}

export type RequestApplicationResolvers = Required<Pick<RouteOptions,
  | "resolveSessionApplication"
  | "resolveAnalytics"
  | "resolveMonitoringApplication"
  | "resolveExecutionRead"
  | "resolveExecutionApplication"
  | "resolveProviderApplication"
>>;

export async function ensureRequestApplications(request: FastifyRequest, options: RouteOptions): Promise<RequestApplications> {
  if (!request.applications) request.applications = await createRequestApplications(request, options);
  return request.applications;
}

export async function createRequestApplications(
  request: FastifyRequest,
  options: RouteOptions,
): Promise<RequestApplications> {
  const [sessions, analytics, monitoring, executionRead, execution, providers] = await Promise.all([
    resolveApplication("session", options.resolveSessionApplication, request),
    resolveApplication("analytics", options.resolveAnalytics, request),
    resolveApplication("monitoring", options.resolveMonitoringApplication, request),
    resolveApplication("execution read", options.resolveExecutionRead, request),
    resolveApplication("execution", options.resolveExecutionApplication, request),
    resolveApplication("provider", options.resolveProviderApplication, request),
  ]);
  const interactions = request.container.interactionCoordinator;
  return { sessions, analytics, monitoring, executionRead, interactions, execution, providers };
}

async function resolveApplication<T>(
  name: string,
  resolver: ((request: FastifyRequest) => T | undefined | Promise<T | undefined>) | undefined,
  request: FastifyRequest,
): Promise<T> {
  if (!resolver) throw new Error(`${name} application resolver is not configured`);
  const resolved = await resolver(request);
  if (resolved === undefined) throw new Error(`${name} application resolver returned no implementation`);
  return resolved;
}
