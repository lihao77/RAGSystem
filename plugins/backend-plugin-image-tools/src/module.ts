import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createImageToolsPlugin, IMAGE_TOOLS_PLUGIN_ID } from "./plugin.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: IMAGE_TOOLS_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    if (config !== undefined && config !== null && (typeof config !== "object" || Array.isArray(config) || Object.keys(config).length > 0)) {
      throw new Error("Image tools plugin install configuration is not supported");
    }
    return createImageToolsPlugin();
  },
};
