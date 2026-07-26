import { LocalExecutionApplication } from "./execution/local-execution-application.js";
import type { RequestApplicationResolvers } from "../../../app/request-applications.js";
import { LocalProviderApplication } from "./provider/local-provider-application.js";
import { LocalMcpApplication } from "./mcp/local-mcp-application.js";
import type { SessionListCursor } from "../../../contracts/session/session.js";

/** Local composition root for request-level application ports. */
export function createLocalRequestApplicationResolvers(): RequestApplicationResolvers {
  return {
    resolveSessionApplication: (request) => requireLocalCapabilities(request)
      .createSessionApplication(request.identity.tenantId),
    resolveMemoryApplication: (request) => {
      const local = requireLocalCapabilities(request);
      return local.createMemoryApplication({
        viewerUserId: request.identity.userId,
        viewerSessionIds: async () => {
          const ids: string[] = [];
          let cursor: SessionListCursor | null = null;
          do {
            const page = await request.container.sessionApplication.listSessions({
              access: { userId: request.identity.userId, includeTenant: true },
              limit: 100,
              cursor,
            });
            ids.push(...page.items.map((session) => session.session_id));
            cursor = page.nextCursor;
          } while (cursor);
          return ids;
        },
      });
    },
    resolveArtifactApplication: (request) => requireLocalCapabilities(request).artifacts,
    resolveAnalytics: (request) => requireLocalCapabilities(request).analytics,
    resolveMonitoringApplication: (request) => requireLocalCapabilities(request).monitoring,
    resolveExecutionRead: (request) => requireLocalCapabilities(request).executionRead,
    resolveExecutionApplication: (request) => new LocalExecutionApplication(request.container.agentExecution),
    resolveProviderApplication: (request) => new LocalProviderApplication(request.container.modelAdapter),
    resolveMcpApplication: (request) => new LocalMcpApplication(request.container.mcp),
  };
}

export function createLocalKnowledgeApplicationResolver() {
  return (request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) => {
    return requireLocalCapabilities(request).knowledge;
  };
}

export function createLocalSessionFileApplicationResolver() {
  return (request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) =>
    requireLocalCapabilities(request).sessionFiles;
}

export function createLocalFileChangeApplicationResolver() {
  return (request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) =>
    requireLocalCapabilities(request).fileChanges;
}

function requireLocalCapabilities(request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) {
  if (!request.container.local) throw new Error("Local request application resolver received a non-Local runtime");
  return request.container.local;
}
