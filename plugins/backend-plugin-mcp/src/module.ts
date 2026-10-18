import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createMcpPlugin, MCP_PLUGIN_ID } from "./plugin.js";
import { createLocalMcpRuntimeFactory } from "./storage/local/runtime.js";

const runtimeFactory = createLocalMcpRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: MCP_PLUGIN_ID, version: "0.2.1" },
  create({ config }) {
    assertEmptyConfig(config);
    return createMcpPlugin({ runtimeFactory });
  },
};

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("MCP plugin install configuration is not supported");
}
