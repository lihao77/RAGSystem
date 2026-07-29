import { fileURLToPath } from "node:url";

import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  loadConfiguredBackendPlugins,
  type LoadConfiguredBackendPluginsOptions,
} from "@ragsystem/backend-core/plugins/plugin-config.js";

export async function createLocalProductPlugins(
  options?: LoadConfiguredBackendPluginsOptions,
): Promise<readonly BackendPlugin[]> {
  return loadConfiguredBackendPlugins({
    configPath: fileURLToPath(new URL("../backend.plugins.yaml", import.meta.url)),
    ...options,
  });
}
