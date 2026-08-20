import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import type {} from "@ragsystem/backend-core/fastify-context.js";

import { PetActivityTracker } from "./pet-activity.js";
import { registerPetAssetRoutes, registerPetUiRoutes } from "./pet-assets.js";
import { createPetSystemConfigExtension, resolvePetConfig } from "./system-config.js";

export const PET_PLUGIN_ID = "@ragsystem/backend-plugin-pet";

export interface PetPluginDependencies {
  /** 覆盖 thumb 动画目录（默认自动解析包内或桌面打包布局）。 */
  readonly assetsRoot?: string;
  /** 覆盖前端 UI 产物目录（默认自动解析包内 ui/dist 或桌面打包布局）。 */
  readonly uiRoot?: string;
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
      const uiRoot = dependencies.uiRoot ?? resolveDefaultPetUiRoot();
      context.ui.register({
        bundleUrl: "/api/pet/ui/bundle.js",
        // 宠物独立窗（Electron）无登录态直开 /pet，view 清单需进公开端点供认证前挂路由
        exposePublic: true,
        views: [{ route: "/pet", entry: "PetPanel", title: "宠物", placement: "standalone", public: true }],
      });
      context.routes.register("public", "/api/pet", async (app) => {
        await app.register(registerPetAssetRoutes, {
          assetsRoot,
          activity: () => activity.snapshot(),
          subscribeActivity: (listener) => activity.onChange(listener),
        });
        await app.register(registerPetUiRoutes, { uiRoot });
      });
      // 本场景 pet 配置：注册 systemConfig 扩展（设置页 schema 驱动表单），读取时机为请求时热读
      context.runtimes.register((runtimeContext) => {
        const unregister = runtimeContext.systemConfig
          ? runtimeContext.systemConfig.registerExtension(
            PET_PLUGIN_ID,
            createPetSystemConfigExtension(runtimeContext.systemConfig.getSection("pet")),
          )
          : () => undefined;
        return { dispose: unregister };
      });
      // 已登录上下文读取本场景 pet 配置；宠物独立窗无 token，前端请求失败回退默认值
      context.routes.register("tenant", "/api/pet", async (app) => {
        app.get("/settings", async (request) => {
          const section = request.container.systemConfig.getSection("pet");
          return resolvePetConfig(section);
        });
      });
    },
  };
}

/**
 * 默认 thumb 动画目录解析（按存在性探测）：
 * 0. 分发产物布局：module.js 与资产平级（bundle-plugin zip 安装形态，见 docs/BACKEND_PLUGIN_CONFIG.md）
 * 1. workspace 布局：<包根>/assets/thumb（src/ 与 dist/ 深度一致，均为两级向上）
 * 2. 桌面打包布局：<plugin-modules>/plugin-assets/pet/thumb（prepare-backend 拷贝位置）
 * 均不存在时返回布局 1 路径（manifest 输出空清单、thumb 404，前端隐藏宠物）。
 */
export function resolveDefaultPetAssetsRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distributedLayout = path.resolve(moduleDir, "assets", "thumb");
  if (fs.existsSync(distributedLayout)) return distributedLayout;
  const packageLayout = path.resolve(moduleDir, "..", "assets", "thumb");
  if (fs.existsSync(packageLayout)) return packageLayout;
  const desktopLayout = path.resolve(moduleDir, "plugin-assets", "pet", "thumb");
  if (fs.existsSync(desktopLayout)) return desktopLayout;
  return packageLayout;
}

/** 默认前端 UI 产物目录解析（三布局探测，同 resolveDefaultPetAssetsRoot；缺失时 bundle 404 前端降级）。 */
export function resolveDefaultPetUiRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distributedLayout = path.resolve(moduleDir, "ui");
  if (fs.existsSync(distributedLayout)) return distributedLayout;
  const packageLayout = path.resolve(moduleDir, "..", "ui", "dist");
  if (fs.existsSync(packageLayout)) return packageLayout;
  const desktopLayout = path.resolve(moduleDir, "plugin-assets", "pet", "ui");
  if (fs.existsSync(desktopLayout)) return desktopLayout;
  return packageLayout;
}
