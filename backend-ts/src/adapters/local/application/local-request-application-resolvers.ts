import { LocalAnalyticsApplication } from "./analytics/local-analytics-application.js";
import { LocalArtifactApplication } from "./artifact/local-artifact-application.js";
import { LocalExecutionReadApplication } from "./execution-read/local-execution-read-application.js";
import { LocalExecutionApplication } from "./execution/local-execution-application.js";
import { LocalMemoryApplication } from "./memory/local-memory-application.js";
import { LocalMonitoringApplication } from "./monitoring/local-monitoring-application.js";
import { LocalSessionApplication } from "./session/local-session-application.js";
import type { RequestApplicationResolvers } from "../../../app/request-applications.js";
import { LocalKnowledgeApplication } from "./knowledge/local-knowledge-application.js";
import { LocalProviderApplication } from "./provider/local-provider-application.js";
import { LocalMcpApplication } from "./mcp/local-mcp-application.js";
import { LocalSessionFileApplication } from "./session-file/local-session-file-application.js";
import { LocalFileChangeApplication } from "./file-change/local-file-change-application.js";

/** Local composition root for request-level application ports. */
export function createLocalRequestApplicationResolvers(): RequestApplicationResolvers {
  return {
    resolveSessionApplication: (request) => {
      const local = requireLocalCapabilities(request);
      return new LocalSessionApplication(request.identity.tenantId, local.sessions, local.conversationStore);
    },
    resolveMemoryApplication: (request) => {
      const local = requireLocalCapabilities(request);
      const sessions = new LocalSessionApplication(
        request.identity.tenantId,
        local.sessions,
        local.conversationStore,
      );
      return new LocalMemoryApplication(
        request.identity.tenantId,
        local.memoryStore,
        local.conversationStore,
        request.identity.userId,
        async () => (await sessions.listSessions({ userIds: [request.identity.userId], limit: 10_000, offset: 0 })).items.map((session) => session.session_id),
      );
    },
    resolveArtifactApplication: (request) => new LocalArtifactApplication(requireLocalCapabilities(request).artifacts),
    resolveAnalytics: (request) => new LocalAnalyticsApplication(requireLocalCapabilities(request).conversationStore),
    resolveMonitoringApplication: (request) => new LocalMonitoringApplication(requireLocalCapabilities(request).conversationStore),
    resolveExecutionRead: (request) => new LocalExecutionReadApplication(request.container.agentExecution, requireLocalCapabilities(request).conversationStore),
    resolveExecutionApplication: (request) => new LocalExecutionApplication(request.container.agentExecution),
    resolveProviderApplication: (request) => new LocalProviderApplication(request.container.modelAdapter),
    resolveMcpApplication: (request) => new LocalMcpApplication(request.container.mcp),
  };
}

export function createLocalKnowledgeApplicationResolver() {
  return (request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) => {
    if (!request.container.local) throw new Error("Local knowledge application resolver received a non-Local runtime");
    return new LocalKnowledgeApplication(request.container.local.knowledgeBase);
  };
}

export function createLocalSessionFileApplicationResolver() {
  return (request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) =>
    new LocalSessionFileApplication(requireLocalCapabilities(request).fileIndex);
}

export function createLocalFileChangeApplicationResolver() {
  return (request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) =>
    new LocalFileChangeApplication(requireLocalCapabilities(request).fileHistory);
}

function requireLocalCapabilities(request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) {
  if (!request.container.local) throw new Error("Local request application resolver received a non-Local runtime");
  return request.container.local;
}
