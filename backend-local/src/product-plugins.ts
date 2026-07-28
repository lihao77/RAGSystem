import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { AppEnv } from "@ragsystem/backend-core/config/env.js";
import path from "node:path";
import {
  loadMutableSession,
  loadMutableSessionForResource,
  loadReadableSession,
  loadReadableSessionForResource,
} from "@ragsystem/backend-core/routes/session-owner.js";
import { createArtifactsPlugin, createFilesystemArtifactStorage } from "@ragsystem/backend-plugin-artifacts/index.js";
import type { LocalDeploymentRuntime } from "./adapters/local/composition/local-deployment-runtime.js";
import { TenantPaths } from "./adapters/local/tenant-paths.js";

export function createLocalProductPlugins(deployment: LocalDeploymentRuntime, env: AppEnv): readonly BackendPlugin[] {
  const applications = deployment.applications;
  return [createArtifactsPlugin({
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
  })];
}
