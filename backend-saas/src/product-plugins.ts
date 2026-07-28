import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
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
import type { SaaSDeploymentRuntime } from "./adapters/saas/composition/saas-deployment-runtime.js";

export function createSaaSProductPlugins(deployment: SaaSDeploymentRuntime): readonly BackendPlugin[] {
  const applications = deployment.applications;
  return [createArtifactsPlugin({
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
  }), createKnowledgePlugin({
    runtimeFactory: createPostgresKnowledgeRuntimeFactory({
      executor: deployment.pluginResources.database,
      objects: deployment.pluginResources.objects,
    }),
    lifecycle: createPostgresKnowledgeLifecycle(deployment.pluginResources.database),
  })];
}
