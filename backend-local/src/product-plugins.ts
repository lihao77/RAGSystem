import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  loadBackendPluginConfig,
  type LoadConfiguredBackendPluginsOptions,
} from "@ragsystem/backend-core/plugins/plugin-config.js";
import { loadBackendPlugins } from "@ragsystem/backend-core/plugins/plugin-loader.js";

export interface LocalProductPluginsOptions extends LoadConfiguredBackendPluginsOptions {
  /**
   * 用户级插件清单（<dataRoot>/plugins/plugins.yaml），与产品清单同格式同校验。
   * 文件不存在时静默跳过；`npm run plugin` 安装器写入这里。
   */
  readonly userPluginsPath?: string;
}

/**
 * 本地产品插件装载 = 产品清单（backend.plugins.yaml，随应用分发只读）
 * + 用户级清单（可选，安装 CLI 写入）。两份清单各自校验；跨清单的重复
 * 插件 id 由 plugin-loader 的拓扑校验拒绝。
 */
export async function createLocalProductPlugins(
  options: LocalProductPluginsOptions = {},
): Promise<readonly BackendPlugin[]> {
  const { userPluginsPath, ...loadOptions } = options;
  const configDirectoryOptions = {
    ...(loadOptions.cwd ? { cwd: loadOptions.cwd } : {}),
    ...(loadOptions.env ? { env: loadOptions.env } : {}),
  };
  const productSpecs = await loadBackendPluginConfig(
    loadOptions.configPath?.trim() || fileURLToPath(new URL("../backend.plugins.yaml", import.meta.url)),
    configDirectoryOptions,
  );
  const userSpecs = userPluginsPath && existsSync(userPluginsPath)
    ? await loadBackendPluginConfig(userPluginsPath, configDirectoryOptions)
    : [];
  return loadBackendPlugins(
    [...productSpecs, ...userSpecs],
    loadOptions.importModule ? { importModule: loadOptions.importModule } : {},
  );
}
