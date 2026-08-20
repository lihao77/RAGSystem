import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createLocalScenesPlugin, LOCAL_SCENES_PLUGIN_ID } from "./plugin.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: LOCAL_SCENES_PLUGIN_ID, version: "0.1.0" },
  create() {
    return createLocalScenesPlugin();
  },
};
