import type { FastifyRequest } from "fastify";

import { LocalAnalyticsApplication } from "../adapters/local/application/analytics/local-analytics-application.js";
import { LocalArtifactApplication } from "../adapters/local/application/artifact/local-artifact-application.js";
import { LocalMonitoringApplication } from "../adapters/local/application/monitoring/local-monitoring-application.js";
import { LocalSessionApplication } from "../adapters/local/application/session/local-session-application.js";
import { LocalExecutionReadApplication } from "../adapters/local/application/execution-read/local-execution-read-application.js";
import { LocalInteractionRecoveryApplication } from "../adapters/local/application/interaction-recovery/local-interaction-recovery-application.js";
import { LocalExecutionApplication } from "../adapters/local/application/execution/local-execution-application.js";
import type { AnalyticsApplication } from "../contracts/analytics-application.js";
import type { ArtifactApplication } from "../contracts/artifact-application.js";
import type { MonitoringApplication } from "../contracts/monitoring-application.js";
import type { SessionApplication } from "../contracts/session/session-application.js";
import type { ExecutionReadApplication } from "../contracts/execution/execution-read-application.js";
import type { InteractionRecoveryApplication } from "../contracts/interaction-recovery-application.js";
import type { ExecutionApplication } from "../contracts/execution/execution-application.js";
import { LocalMemoryApplication } from "../adapters/local/application/memory/local-memory-application.js";
import type { MemoryApplication } from "../services/memory/index.js";
import type { RouteOptions } from "../routes/route-options.js";

export interface RequestApplications {
  sessions: SessionApplication;
  memory: MemoryApplication;
  artifacts: ArtifactApplication;
  analytics: AnalyticsApplication;
  monitoring: MonitoringApplication;
  executionRead: ExecutionReadApplication;
  interactions: InteractionRecoveryApplication;
  execution: ExecutionApplication;
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
  const [resolvedMemory, resolvedArtifacts, resolvedAnalytics, resolvedMonitoring, resolvedExecutionRead, resolvedInteractions] = await Promise.all([
    options.resolveMemoryApplication?.(request),
    options.resolveArtifactApplication?.(request),
    options.resolveAnalytics?.(request),
    options.resolveMonitoringApplication?.(request),
    options.resolveExecutionRead?.(request),
    options.resolveInteractionRecovery?.(request),
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
  const interactions = resolvedInteractions
    ?? new LocalInteractionRecoveryApplication(request.container.pendingInteractions, request.container.conversationStore);

  const execution = new LocalExecutionApplication(request.container.agentExecution, request.container.resumeExecutor);
  return { sessions, memory, artifacts, analytics, monitoring, executionRead, interactions, execution };
}
