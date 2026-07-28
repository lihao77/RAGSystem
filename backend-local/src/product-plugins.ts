import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  loadMutableSession,
  loadMutableSessionForResource,
  loadReadableSession,
  loadReadableSessionForResource,
} from "@ragsystem/backend-core/routes/session-owner.js";
import { createArtifactsPlugin } from "@ragsystem/backend-plugin-artifacts/index.js";
import type { LocalDeploymentRuntime } from "./adapters/local/composition/local-deployment-runtime.js";

export function createLocalProductPlugins(deployment: LocalDeploymentRuntime): readonly BackendPlugin[] {
  const applications = deployment.applications;
  return [createArtifactsPlugin({
    resolveArtifactApplication: applications.resolveArtifactApplication,
    resolveArtifactApplicationForTenant: deployment.resolveArtifactApplicationForTenant,
    resolveSessionApplication: applications.resolveSessionApplication,
    sessionAccess: {
      loadReadableSession,
      loadMutableSession,
      loadReadableSessionForResource,
      loadMutableSessionForResource,
    },
  })];
}
