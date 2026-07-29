import type { SecretResolver } from "@ragsystem/backend-core/contracts/integrations/secret-resolver.js";
import type { BackendPlugin, BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  BACKEND_HOST_RESOURCES,
  findBackendPluginResource,
  requireBackendPluginResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";

import { createMcpPlugin, MCP_PLUGIN_ID } from "./plugin.js";
import { createLocalMcpRuntimeFactory } from "./storage/local/runtime.js";
import { createPostgresMcpLifecycle } from "./storage/postgres/lifecycle.js";
import type { PostgresMcpExecutor } from "./storage/postgres/repository.js";
import { createPostgresMcpRuntimeFactory } from "./storage/postgres/runtime.js";

const localRuntimeFactory = createLocalMcpRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: MCP_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createInstalledMcpPlugin();
  },
};

function createInstalledMcpPlugin(): BackendPlugin {
  const base = createMcpPlugin({
    runtimeFactory: (context) => {
      if (context.deploymentKind === "local") return localRuntimeFactory(context);
      const executor = requireBackendPluginResource<PostgresMcpExecutor>(
        context.resources,
        BACKEND_HOST_RESOURCES.runtimeDatabase,
      );
      const secrets = findBackendPluginResource<SecretResolver>(
        context.resources,
        BACKEND_HOST_RESOURCES.secrets,
      );
      return createPostgresMcpRuntimeFactory({
        executor,
        ...(secrets ? { secrets } : {}),
      })(context);
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
        const lifecycle = createPostgresMcpLifecycle(
          requireBackendPluginResource<PostgresMcpExecutor>(
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
  throw new Error("MCP plugin install configuration is not supported");
}
