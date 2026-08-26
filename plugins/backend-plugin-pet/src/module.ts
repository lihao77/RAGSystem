import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createPetPlugin, PET_PLUGIN_ID } from "./plugin.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: PET_PLUGIN_ID, version: "0.2.0" },
  create({ config }) {
    const parsed = parseInstallConfig(config);
    return createPetPlugin({
      ...(parsed.assetsRoot === undefined ? {} : { assetsRoot: parsed.assetsRoot }),
      ...(parsed.uiRoot === undefined ? {} : { uiRoot: parsed.uiRoot }),
    });
  },
};

/** 安装配置仅支持 { assets_root?: string, ui_root?: string }（均可选，覆盖默认目录解析）。 */
function parseInstallConfig(config: unknown): { assetsRoot?: string; uiRoot?: string } {
  if (config === undefined || config === null) return {};
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Pet plugin install configuration must be an object");
  }
  const record = config as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "assets_root" && key !== "ui_root");
  if (unknownKeys.length > 0) {
    throw new Error(`Pet plugin install configuration does not support: ${unknownKeys.join(", ")}`);
  }
  const result: { assetsRoot?: string; uiRoot?: string } = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Pet plugin install configuration '${key}' must be a non-empty string`);
    }
    if (key === "assets_root") result.assetsRoot = value;
    else result.uiRoot = value;
  }
  return result;
}
