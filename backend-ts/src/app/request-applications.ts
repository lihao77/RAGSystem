import type { FastifyRequest } from "fastify";

import { LocalAnalyticsApplication } from "../adapters/local/local-analytics-application.js";
import { LocalArtifactApplication } from "../adapters/local/local-artifact-application.js";
import { LocalMonitoringApplication } from "../adapters/local/local-monitoring-application.js";
import { LocalSessionApplication } from "../adapters/local/local-session-application.js";
import { LocalExecutionReadApplication } from "../adapters/local/local-execution-read-application.js";
import type { AnalyticsApplication } from "../contracts/analytics-application.js";
import type { ArtifactApplication } from "../contracts/artifact-application.js";
import type { MonitoringApplication } from "../contracts/monitoring-application.js";
import type { SessionApplication } from "../contracts/session-application.js";
import type { ExecutionReadApplication } from "../contracts/execution-read-application.js";
import { LocalMemoryApplication } from "../services/memory/local-memory-application.js";
import type { MemoryApplication } from "../services/memory/index.js";
import type { RouteOptions } from "../routes/route-options.js";

export interface RequestApplications {
  sessions: SessionApplication;
  memory: MemoryApplication;
  artifacts: ArtifactApplication;
  analytics: AnalyticsApplication;
  monitoring: MonitoringApplication;
  executionRead: ExecutionReadApplication;
}

export async function ensureRequestApplications(request: FastifyRequest, options: RouteOptions): Promise<RequestApplications> {
  if (!request.applications) request.applications = await createRequestApplications(request, options);
  return request.applications;
}

export async function createRequestApplications(
  request: FastifyRequest,
  options: RouteOptions,
): Promise<RequestApplications> {
  const sessions = await options.resolveSessionApplication?.(request)
    ?? new LocalSessionApplication(request.identity.tenantId, request.container.sessionApplication, request.container.conversationStore);
  const [resolvedMemory, resolvedArtifacts, resolvedAnalytics, resolvedMonitoring, resolvedExecutionRead] = await Promise.all([
    options.resolveMemoryApplication?.(request),
    options.resolveArtifactApplication?.(request),
    options.resolveAnalytics?.(request),
    options.resolveMonitoringApplication?.(request),
    options.resolveSaaSAgentReadApplication?.(request),
  ]);
  const memory = resolvedMemory
    ?? new LocalMemoryApplication(
      request.identity.tenantId,
      request.container.memoryStore,
      request.container.conversationStore,
      request.identity.userId,
      async () => (await sessions.listSessions({ userIds: [request.identity.userId], limit: 10_000, offset: 0 })).items.map((session) => session.session_id),
    );
  const artifacts = resolvedArtifacts ?? new LocalArtifactApplication(request.container.artifacts);
  const analytics = resolvedAnalytics ?? new LocalAnalyticsApplication(request.container.conversationStore);
  const monitoring = resolvedMonitoring ?? new LocalMonitoringApplication(request.container.conversationStore);
  const executionRead = resolvedExecutionRead ?? new LocalExecutionReadApplication(request.container.agentExecution, request.container.conversationStore);

  return { sessions, memory, artifacts, analytics, monitoring, executionRead };
}
