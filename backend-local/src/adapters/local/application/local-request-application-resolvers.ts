import { LocalExecutionApplication } from "./execution/local-execution-application.js";
import "@ragsystem/backend-core/fastify-context.js";
import type { RequestApplicationResolvers } from "@ragsystem/backend-core/app/request-applications.js";
import { LocalProviderApplication } from "./provider/local-provider-application.js";
import { LocalWorkspaceFileApplication } from "./workspace-file/local-workspace-file-application.js";

/** Local composition root for request-level application ports. */
export function createLocalRequestApplicationResolvers(): RequestApplicationResolvers {
  return {
    resolveSessionApplication: (request) => requireLocalCapabilities(request)
      .createSessionApplication(request.identity.tenantId),
    resolveAnalytics: (request) => requireLocalCapabilities(request).analytics,
    resolveMonitoringApplication: (request) => requireLocalCapabilities(request).monitoring,
    resolveExecutionRead: (request) => requireLocalCapabilities(request).executionRead,
    resolveExecutionApplication: (request) => new LocalExecutionApplication(request.container.agentExecution),
    resolveProviderApplication: (request) => new LocalProviderApplication(request.container.modelAdapter),
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

export function createLocalWorkspaceFileApplicationResolver() {
  return (request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) => {
    const local = requireLocalCapabilities(request);
    const sessions = local.createSessionApplication(request.identity.tenantId);
    return new LocalWorkspaceFileApplication(
      (sessionId) => sessions.resolveWorkspaceRoot(sessionId),
      // 项目级浏览的根解析。listWorkspacesByIds 不筛软删（见 workspace-ops.listByIds），
      // 这里显式排除 removed_at，软删项目按不存在处理；构造时已绑定 tenant，天然租户隔离。
      async (workspaceId) => {
        const workspace = (await sessions.listWorkspacesByIds([workspaceId]))[0];
        if (!workspace || workspace.removed_at) return null;
        return workspace.root_path ?? null;
      },
    );
  };
}

function requireLocalCapabilities(request: Parameters<RequestApplicationResolvers["resolveSessionApplication"]>[0]) {
  if (!request.container.local) throw new Error("Local request application resolver received a non-Local runtime");
  return request.container.local;
}
