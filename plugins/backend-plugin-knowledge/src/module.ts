import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createKnowledgePlugin, KNOWLEDGE_PLUGIN_ID } from "./plugin.js";
import { createLocalKnowledgeRuntimeFactory } from "./storage/local/runtime.js";

const runtimeFactory = createLocalKnowledgeRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: KNOWLEDGE_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createKnowledgePlugin({ runtimeFactory });
  },
};

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Knowledge plugin install configuration is not supported");
}
