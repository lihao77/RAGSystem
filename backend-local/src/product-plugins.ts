import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  loadBackendPlugins,
  type LoadBackendPluginsOptions,
} from "@ragsystem/backend-core/plugins/plugin-loader.js";
import {
  selectBackendPluginModules,
  type BackendPluginModuleCatalog,
} from "@ragsystem/backend-core/plugins/plugin-selection.js";

export const LOCAL_PLUGIN_MODULES = {
  artifacts: "@ragsystem/backend-plugin-artifacts/module.js",
  executionTools: "@ragsystem/backend-plugin-execution-tools/module.js",
  documentTools: "@ragsystem/backend-plugin-document-tools/module.js",
  daemonFeishu: "@ragsystem/backend-plugin-daemon-feishu/module.js",
  knowledge: "@ragsystem/backend-plugin-knowledge/module.js",
  memory: "@ragsystem/backend-plugin-memory/module.js",
  mcp: "@ragsystem/backend-plugin-mcp/module.js",
  skills: "@ragsystem/backend-plugin-skills/module.js",
  widget: "@ragsystem/backend-plugin-widget/module.js",
} satisfies BackendPluginModuleCatalog;

export async function createLocalProductPlugins(
  selection?: string,
  options?: LoadBackendPluginsOptions,
): Promise<readonly BackendPlugin[]> {
  return loadBackendPlugins(selectBackendPluginModules(LOCAL_PLUGIN_MODULES, selection), options);
}
