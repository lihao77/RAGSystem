import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createSkillsPlugin, SKILLS_PLUGIN_ID } from "./plugin.js";
import { createLocalSkillsRuntimeFactory } from "./storage/local/runtime.js";

const runtimeFactory = createLocalSkillsRuntimeFactory();

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: SKILLS_PLUGIN_ID, version: "0.2.0" },
  create({ config }) {
    assertEmptyConfig(config);
    return createSkillsPlugin({ runtimeFactory });
  },
};

function assertEmptyConfig(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config === "object" && !Array.isArray(config) && Object.keys(config).length === 0) return;
  throw new Error("Skills plugin install configuration is not supported");
}
