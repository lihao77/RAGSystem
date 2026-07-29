import type { ObjectStorage } from "@ragsystem/backend-core/contracts/storage/object-storage.js";
import type { BackendPlugin, BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  BACKEND_HOST_RESOURCES,
  requireBackendPluginResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";

import { createSkillsPlugin, SKILLS_PLUGIN_ID } from "./plugin.js";
import { createLocalSkillsRuntimeFactory } from "./storage/local/runtime.js";
import type { SkillsPostgresExecutor } from "./storage/postgres/executor.js";
import { createPostgresSkillsLifecycle } from "./storage/postgres/lifecycle.js";
import { createPostgresSkillsRuntimeFactory } from "./storage/postgres/runtime.js";

const localRuntimeFactory = createLocalSkillsRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: SKILLS_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createInstalledSkillsPlugin();
  },
};

function createInstalledSkillsPlugin(): BackendPlugin {
  const base = createSkillsPlugin({
    runtimeFactory: (context) => {
      if (context.deploymentKind === "local") return localRuntimeFactory(context);
      const executor = requireBackendPluginResource<SkillsPostgresExecutor>(
        context.resources,
        BACKEND_HOST_RESOURCES.runtimeDatabase,
      );
      const objects = requireBackendPluginResource<ObjectStorage>(
        context.resources,
        BACKEND_HOST_RESOURCES.objectStorage,
      );
      return createPostgresSkillsRuntimeFactory({ executor, objects })(context);
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
        const lifecycle = createPostgresSkillsLifecycle(
          requireBackendPluginResource<SkillsPostgresExecutor>(
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
  throw new Error("Skills plugin install configuration is not supported");
}
