import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type { DeploymentApplicationResolvers } from "@ragsystem/backend-core/app/deployment-runtime.js";
import {
  loadMutableSession,
  loadMutableSessionForResource,
  loadReadableSession,
  loadReadableSessionForResource,
} from "@ragsystem/backend-core/routes/session-owner.js";
import { createArtifactsPlugin } from "@ragsystem/backend-plugin-artifacts/index.js";

export function createSaaSProductPlugins(applications: DeploymentApplicationResolvers): readonly BackendPlugin[] {
  return [createArtifactsPlugin({
    resolveArtifactApplication: applications.resolveArtifactApplication,
    resolveSessionApplication: applications.resolveSessionApplication,
    sessionAccess: {
      loadReadableSession,
      loadMutableSession,
      loadReadableSessionForResource,
      loadMutableSessionForResource,
    },
  })];
}
