import type { BackendPlugin, BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  BACKEND_HOST_RESOURCES,
  requireBackendPluginResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";
import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";

import { createKnowledgePlugin, KNOWLEDGE_PLUGIN_ID } from "./plugin.js";
import { createLocalKnowledgeRuntimeFactory } from "./storage/local/runtime.js";
import type { KnowledgePostgresExecutor } from "./storage/postgres/executor.js";
import { createPostgresKnowledgeLifecycle } from "./storage/postgres/lifecycle.js";
import { createPostgresKnowledgeRuntimeFactory } from "./storage/postgres/runtime.js";

const localRuntimeFactory = createLocalKnowledgeRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: KNOWLEDGE_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createInstalledKnowledgePlugin();
  },
};

function createInstalledKnowledgePlugin(): BackendPlugin {
  const base = createKnowledgePlugin({
    runtimeFactory: (context) => {
      if (context.deploymentKind === "local") return localRuntimeFactory(context);
      const executor = requireBackendPluginResource<KnowledgePostgresExecutor>(
        context.resources,
        BACKEND_HOST_RESOURCES.runtimeDatabase,
      );
      const objects = requireBackendPluginResource<ObjectStorage>(
        context.resources,
        BACKEND_HOST_RESOURCES.objectStorage,
      );
      return createPostgresKnowledgeRuntimeFactory({ executor, objects })(context);
    },
  });
  return {
    ...base,
    async register(context) {
      await base.register(context);
      context.applications.register(({ resources }) => {
        const deployment = requireBackendPluginResource<{ kind: "local" | "saas" }>(
          resources,
          BACKEND_HOST_RESOURCES.deployment,
        );
        if (deployment.kind === "local") return {};
        const lifecycle = createPostgresKnowledgeLifecycle(
          requireBackendPluginResource<KnowledgePostgresExecutor>(
            resources,
            BACKEND_HOST_RESOURCES.runtimeDatabase,
          ),
        );
        return {
          ...(lifecycle.start ? { start: () => lifecycle.start?.() } : {}),
          ...(lifecycle.stop ? { dispose: () => lifecycle.stop?.() } : {}),
        };
      });
    },
  };
}

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Knowledge plugin install configuration is not supported");
}
