import type { BackendPluginModule } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { createPetPlugin, PET_PLUGIN_ID } from "./plugin.js";

export const backendPluginModule: BackendPluginModule = {
  apiVersion: 1,
  manifest: { id: PET_PLUGIN_ID, version: "0.1.0" },
  create({ config }) {
    const assetsRoot = parseAssetsRoot(config);
    return createPetPlugin(assetsRoot === undefined ? {} : { assetsRoot });
  },
};

/** 安装配置仅支持 { assets_root: string }（可选，覆盖默认动画目录解析）。 */
function parseAssetsRoot(config: unknown): string | undefined {
  if (config === undefined || config === null) return undefined;
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Pet plugin install configuration must be an object");
  }
  const keys = Object.keys(config as Record<string, unknown>);
  if (keys.length === 0) return undefined;
  const assetsRoot = (config as Record<string, unknown>).assets_root;
  if (keys.length > 1 || keys[0] !== "assets_root" || typeof assetsRoot !== "string" || assetsRoot.trim() === "") {
    throw new Error("Pet plugin install configuration supports only { assets_root: string }");
  }
  return assetsRoot;
}
