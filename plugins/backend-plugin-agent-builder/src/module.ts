import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { AGENT_BUILDER_PLUGIN_ID, createAgentBuilderPlugin } from "./plugin.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: AGENT_BUILDER_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createAgentBuilderPlugin();
  },
};

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Agent Builder plugin install configuration is not supported");
}
