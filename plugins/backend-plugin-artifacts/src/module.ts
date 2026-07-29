import type { BackendPlugin, BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  BACKEND_HOST_RESOURCES,
  requireBackendPluginResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";
import {
  loadMutableSession,
  loadMutableSessionForResource,
  loadReadableSession,
  loadReadableSessionForResource,
} from "@ragsystem/backend-core/routes/session-owner.js";

import type { ArtifactSessionAccess } from "./dependencies.js";
import { ARTIFACTS_PLUGIN_ID, createArtifactsPlugin } from "./plugin.js";
import { createFilesystemArtifactStorage } from "./storage/filesystem/index.js";
import { createPostgresArtifactStorage } from "./storage/postgres/index.js";
import type {
  ArtifactObjectStorage,
  ArtifactPostgresExecutor,
} from "./storage/postgres/resources.js";
import type { ArtifactStorageProvider } from "./storage/storage-provider.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: ARTIFACTS_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createInstalledArtifactsPlugin();
  },
};

function createInstalledArtifactsPlugin(): BackendPlugin {
  let activeStorage: ArtifactStorageProvider | null = null;
  const storage: ArtifactStorageProvider = {
    applicationForTenant(tenantId) {
      if (!activeStorage) throw new Error("Artifact storage is not initialized");
      return activeStorage.applicationForTenant(tenantId);
    },
  };
  const base = createArtifactsPlugin({ storage, sessionAccess: createSessionAccess() });
  return {
    ...base,
    async register(context) {
      await base.register(context);
      context.applications.register(({ resources }) => {
        const deployment = requireBackendPluginResource<{ kind: "local" | "saas" }>(
          resources,
          BACKEND_HOST_RESOURCES.deployment,
        );
        const created = deployment.kind === "local"
          ? createFilesystemArtifactStorage({
              resolveDataRoot: requireBackendPluginResource<(tenantId: string) => string>(
                resources,
                BACKEND_HOST_RESOURCES.tenantDataRoot,
              ),
            })
          : createPostgresArtifactStorage({
              executor: requireBackendPluginResource<ArtifactPostgresExecutor>(
                resources,
                BACKEND_HOST_RESOURCES.runtimeDatabase,
              ),
              objects: requireBackendPluginResource<ArtifactObjectStorage>(
                resources,
                BACKEND_HOST_RESOURCES.objectStorage,
              ),
            });
        activeStorage = created;
        return {
          ...(created.start ? { start: () => created.start?.() } : {}),
          async dispose() {
            try {
              await created.stop?.();
            } finally {
              if (activeStorage === created) activeStorage = null;
            }
          },
        };
      });
    },
  };
}

function createSessionAccess(): ArtifactSessionAccess {
  return {
    assertReadable: async (request, sessionId) => { await loadReadableSession(request, sessionId); },
    assertMutable: async (request, sessionId) => { await loadMutableSession(request, sessionId); },
    assertResourceReadable: async (request, sessionId, message) => {
      await loadReadableSessionForResource(request, sessionId, message);
    },
    assertResourceMutable: async (request, sessionId, message) => {
      await loadMutableSessionForResource(request, sessionId, message);
    },
  };
}

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Artifacts plugin install configuration is not supported");
}
