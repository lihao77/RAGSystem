import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { createSandboxPlugin, SANDBOX_PLUGIN_ID } from "./plugin.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: SANDBOX_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    if (config !== undefined && config !== null && typeof config === "object" && Object.keys(config).length > 0) {
      throw new Error("Sandbox plugin does not accept configuration in phase one");
    }
    return createSandboxPlugin();
  },
};
