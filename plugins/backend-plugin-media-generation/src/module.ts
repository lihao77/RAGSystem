import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createMediaGenerationPlugin, PLUGIN_ID } from "./plugin.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    if (config !== undefined && config !== null) {
      throw new Error(`@ragsystem/backend-plugin-media-generation 暂不支持安装配置（config 请留空）`);
    }
    return createMediaGenerationPlugin();
  },
};
