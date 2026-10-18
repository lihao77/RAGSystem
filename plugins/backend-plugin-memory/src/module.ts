import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createMemoryPlugin, MEMORY_PLUGIN_ID } from "./plugin.js";
import { createLocalMemoryRuntimeFactory } from "./storage/local/runtime.js";

const runtimeFactory = createLocalMemoryRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: MEMORY_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createMemoryPlugin({ runtimeFactory });
  },
};

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Memory plugin install configuration is not supported");
}
