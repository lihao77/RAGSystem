import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";

import { PetActivityTracker } from "./pet-activity.js";
import { registerPetAssetRoutes } from "./pet-assets.js";

export const PET_PLUGIN_ID = "@ragsystem/backend-plugin-pet";

export interface PetPluginDependencies {
  /** 覆盖 thumb 动画目录（默认自动解析包内或桌面打包布局）。 */
  readonly assetsRoot?: string;
  /** 注入自定义活跃度跟踪器（测试用）。 */
  readonly activityTracker?: PetActivityTracker;
}

export function createPetPlugin(dependencies: PetPluginDependencies = {}): BackendPlugin {
  const activity = dependencies.activityTracker ?? new PetActivityTracker();
  return {
    manifest: { id: PET_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      activity.install(context.hooks);
      const assetsRoot = dependencies.assetsRoot ?? resolveDefaultPetAssetsRoot();
      context.routes.register("public", "/api/pet", async (app) => {
        await app.register(registerPetAssetRoutes, {
          assetsRoot,
          activity: () => activity.snapshot(),
          subscribeActivity: (listener) => activity.onChange(listener),
        });
      });
    },
  };
}

/**
 * 默认 thumb 动画目录解析（按存在性探测）：
 * 1. workspace 布局：<包根>/assets/thumb（src/ 与 dist/ 深度一致，均为两级向上）
 * 2. 桌面打包布局：<plugin-modules>/plugin-assets/pet/thumb（prepare-backend 拷贝位置；
 *    esbuild bundle 后 import.meta.url 位于 plugin-modules/ 下）
 * 均不存在时返回布局 1 路径（manifest 输出空清单、thumb 404，前端隐藏宠物）。
 */
export function resolveDefaultPetAssetsRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageLayout = path.resolve(moduleDir, "..", "assets", "thumb");
  if (fs.existsSync(packageLayout)) return packageLayout;
  const desktopLayout = path.resolve(moduleDir, "plugin-assets", "pet", "thumb");
  if (fs.existsSync(desktopLayout)) return desktopLayout;
  return packageLayout;
}
