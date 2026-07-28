import type { BackendPlugin, BackendPluginCatalog } from "@ragsystem/backend-core/plugins/index.js";
import { selectBackendPlugins } from "@ragsystem/backend-core/plugins/index.js";
import {
  loadMutableSession,
  loadMutableSessionForResource,
  loadReadableSession,
  loadReadableSessionForResource,
} from "@ragsystem/backend-core/routes/session-owner.js";
import { createArtifactsPlugin, createPostgresArtifactStorage } from "@ragsystem/backend-plugin-artifacts/index.js";
import {
  createKnowledgePlugin,
  createPostgresKnowledgeLifecycle,
  createPostgresKnowledgeRuntimeFactory,
} from "@ragsystem/backend-plugin-knowledge/index.js";
import {
  createMemoryPlugin,
  createPostgresMemoryLifecycle,
  createPostgresMemoryRuntimeFactory,
} from "@ragsystem/backend-plugin-memory/index.js";
import {
  createMcpPlugin,
  createPostgresMcpLifecycle,
  createPostgresMcpRuntimeFactory,
} from "@ragsystem/backend-plugin-mcp/index.js";
import {
  createPostgresSkillsLifecycle,
  createPostgresSkillsRuntimeFactory,
  createSkillsPlugin,
} from "@ragsystem/backend-plugin-skills/index.js";
import type { SaaSDeploymentRuntime } from "./adapters/saas/composition/saas-deployment-runtime.js";

export function createSaaSProductPlugins(
  deployment: SaaSDeploymentRuntime,
  selection?: string,
): readonly BackendPlugin[] {
  const applications = deployment.applications;
  const catalog = {
    artifacts: () => createArtifactsPlugin({
      storage: createPostgresArtifactStorage({
        executor: deployment.pluginResources.database,
        objects: deployment.pluginResources.objects,
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
    knowledge: () => createKnowledgePlugin({
      runtimeFactory: createPostgresKnowledgeRuntimeFactory({
        executor: deployment.pluginResources.database,
        objects: deployment.pluginResources.objects,
      }),
      lifecycle: createPostgresKnowledgeLifecycle(deployment.pluginResources.database),
    }),
    memory: () => createMemoryPlugin({
      runtimeFactory: createPostgresMemoryRuntimeFactory({
        executor: deployment.pluginResources.database,
      }),
      lifecycle: createPostgresMemoryLifecycle(deployment.pluginResources.database),
    }),
    mcp: () => createMcpPlugin({
      runtimeFactory: createPostgresMcpRuntimeFactory({
        executor: deployment.pluginResources.database,
        secrets: deployment.pluginResources.secrets,
      }),
      lifecycle: createPostgresMcpLifecycle(deployment.pluginResources.database),
    }),
    skills: () => createSkillsPlugin({
      runtimeFactory: createPostgresSkillsRuntimeFactory({
        executor: deployment.pluginResources.database,
        objects: deployment.pluginResources.objects,
      }),
      lifecycle: createPostgresSkillsLifecycle(deployment.pluginResources.database),
    }),
  } satisfies BackendPluginCatalog;
  return selectBackendPlugins(catalog, selection);
}
