import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PluginAssetDirOptions {
  /** 调用方插件的 import.meta.url（资产布局以插件模块位置为基准，无法从 helper 内部推断）。 */
  readonly moduleUrl: string;
  /** 资产相对路径（如 "assets/thumb"、"ui"），相对插件 module.js 所在目录。 */
  readonly relative: string;
  /**
   * workspace 布局的相对路径覆盖（默认同 relative）。
   * 产物目录在 workspace 与分发形态位置不同时用（如 UI：workspace 在 ui/dist，分发在 ui/）。
   */
  readonly workspaceRelative?: string;
  /** 插件 manifest id；短名（去 @scope/ 前缀）用于桌面布局的 plugin-assets/<短id> 段。 */
  readonly pluginId: string;
}

/**
 * 插件资产目录统一解析（三布局探测，全部 miss 时返回 workspace 候选供调用方输出空态/404）。
 *
 * 布局按优先级：
 * 0. 分发产物（bundle-plugin zip 安装）：module.js 与资产平级 —— <moduleDir>/<relative>
 * 1. workspace：<包根>/<workspaceRelative>（src/ 与 dist/ 深度一致，moduleDir 上一级）
 * 2. 桌面打包（prepare-backend）：<plugin-modules>/plugin-assets/<短id>/<relative>
 */
export function resolvePluginAssetDir(options: PluginAssetDirOptions): string {
  const moduleDir = path.dirname(fileURLToPath(options.moduleUrl));
  const normalized = options.relative.replace(/^[/\\]+/, "");
  const workspaceRelative = (options.workspaceRelative ?? options.relative).replace(/^[/\\]+/, "");
  const shortId = options.pluginId.includes("/") ? options.pluginId.split("/").pop()! : options.pluginId;
  const candidates = [
    path.resolve(moduleDir, normalized),
    path.resolve(moduleDir, "..", workspaceRelative),
    path.resolve(moduleDir, "plugin-assets", shortId, normalized),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[1]!;
}
