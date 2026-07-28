import type { BackendPlugin, BackendPluginCatalog } from "@ragsystem/backend-core/plugins/index.js";
import { selectBackendPlugins } from "@ragsystem/backend-core/plugins/index.js";
import type { AppEnv } from "@ragsystem/backend-core/config/env.js";
import path from "node:path";
import {
  loadMutableSession,
  loadMutableSessionForResource,
  loadReadableSession,
  loadReadableSessionForResource,
} from "@ragsystem/backend-core/routes/session-owner.js";
import { createArtifactsPlugin, createFilesystemArtifactStorage } from "@ragsystem/backend-plugin-artifacts/index.js";
import { createKnowledgePlugin, createLocalKnowledgeRuntimeFactory } from "@ragsystem/backend-plugin-knowledge/index.js";
import { createLocalMemoryRuntimeFactory, createMemoryPlugin } from "@ragsystem/backend-plugin-memory/index.js";
import { createLocalMcpRuntimeFactory, createMcpPlugin } from "@ragsystem/backend-plugin-mcp/index.js";
import { createExecutionToolsPlugin, createLocalExecutionToolsRuntimeFactory } from "@ragsystem/backend-plugin-execution-tools/index.js";
import { createLocalSkillsRuntimeFactory, createSkillsPlugin } from "@ragsystem/backend-plugin-skills/index.js";
import type { LocalDeploymentRuntime } from "./adapters/local/composition/local-deployment-runtime.js";
import { TenantPaths } from "./adapters/local/tenant-paths.js";

export function createLocalProductPlugins(
  deployment: LocalDeploymentRuntime,
  env: AppEnv,
  selection?: string,
): readonly BackendPlugin[] {
  const applications = deployment.applications;
  const catalog = {
    artifacts: () => createArtifactsPlugin({
      storage: createFilesystemArtifactStorage({
        resolveDataRoot: (tenantId) => new TenantPaths(path.join(env.tenantsRoot, tenantId)).dataRoot,
      }),
      sessionAccess: {
        assertReadable: async (request, sessionId) => {
          await loadReadableSession(request, sessionId, await applications.resolveSessionApplication(request));
        },
        assertMutable: async (request, sessionId) => {
          await loadMutableSession(request, sessionId, await applications.resolveSessionApplication(request));
        },
        assertResourceReadable: async (request, sessionId, message) => {
          await loadReadableSessionForResource(request, sessionId, message, await applications.resolveSessionApplication(request));
        },
        assertResourceMutable: async (request, sessionId, message) => {
          await loadMutableSessionForResource(request, sessionId, message, await applications.resolveSessionApplication(request));
        },
      },
    }),
    executionTools: () => createExecutionToolsPlugin({ runtimeFactory: createLocalExecutionToolsRuntimeFactory() }),
    knowledge: () => createKnowledgePlugin({ runtimeFactory: createLocalKnowledgeRuntimeFactory() }),
    memory: () => createMemoryPlugin({ runtimeFactory: createLocalMemoryRuntimeFactory() }),
    mcp: () => createMcpPlugin({ runtimeFactory: createLocalMcpRuntimeFactory() }),
    skills: () => createSkillsPlugin({ runtimeFactory: createLocalSkillsRuntimeFactory() }),
  } satisfies BackendPluginCatalog;
  return selectBackendPlugins(catalog, selection);
}
