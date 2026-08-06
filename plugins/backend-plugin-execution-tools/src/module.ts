import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createExecutionToolsPlugin, EXECUTION_TOOLS_PLUGIN_ID } from "./plugin.js";
import { createLocalExecutionToolsRuntimeFactory } from "./storage/local/runtime.js";
import { createSandboxedExecutionToolsRuntimeFactory } from "./storage/saas/runtime.js";
import { findExecutionToolsSandbox } from "./resources.js";

const localRuntimeFactory = createLocalExecutionToolsRuntimeFactory();
const sandboxedRuntimeFactory = createSandboxedExecutionToolsRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: EXECUTION_TOOLS_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createExecutionToolsPlugin({
      runtimeFactory: (context) => context.deploymentKind === "local"
        ? (findExecutionToolsSandbox(context.resources) ? sandboxedRuntimeFactory(context) : localRuntimeFactory(context))
        : sandboxedRuntimeFactory(context),
    });
  },
};

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Execution tools plugin does not accept configuration");
}
