import type { BackendPlugin, BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  BACKEND_HOST_RESOURCES,
  requireBackendPluginResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";

import { createMemoryPlugin, MEMORY_PLUGIN_ID } from "./plugin.js";
import { createLocalMemoryRuntimeFactory } from "./storage/local/runtime.js";
import { createPostgresMemoryLifecycle } from "./storage/postgres/lifecycle.js";
import type { PostgresMemoryExecutor } from "./storage/postgres/repository.js";
import { createPostgresMemoryRuntimeFactory } from "./storage/postgres/runtime.js";

const localRuntimeFactory = createLocalMemoryRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: MEMORY_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createInstalledMemoryPlugin();
  },
};

function createInstalledMemoryPlugin(): BackendPlugin {
  const base = createMemoryPlugin({
    runtimeFactory: (context) => {
      if (context.deploymentKind === "local") return localRuntimeFactory(context);
      const executor = requireBackendPluginResource<PostgresMemoryExecutor>(
        context.resources,
        BACKEND_HOST_RESOURCES.runtimeDatabase,
      );
      return createPostgresMemoryRuntimeFactory({ executor })(context);
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
        const lifecycle = createPostgresMemoryLifecycle(
          requireBackendPluginResource<PostgresMemoryExecutor>(
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
  throw new Error("Memory plugin install configuration is not supported");
}
