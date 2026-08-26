import fs from "node:fs";
import path from "node:path";

import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { resolvePluginAssetDir } from "@ragsystem/backend-core/plugins/plugin-assets.js";
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
    manifest: { id: PET_PLUGIN_ID, version: "0.2.0" },
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
      // 本场景 pet 配置：注册 systemConfig 扩展（设置页 schema 驱动表单），读取时机为请求时热读；
      // 同时订阅"交互进入 pending"（审批/用户输入等待用户）→ 驱动宠物端系统通知
      context.runtimes.register((runtimeContext) => {
        const unregister = runtimeContext.systemConfig
          ? runtimeContext.systemConfig.registerExtension(
            PET_PLUGIN_ID,
            createPetSystemConfigExtension(runtimeContext.systemConfig.getSection("pet")),
          )
          : () => undefined;
        const unsubscribeInteractions = runtimeContext.pendingInteractions.onInteractionRequired((notice) => {
          activity.noteInteractionRequired({
            id: notice.id,
            kind: notice.kind,
            tool: notice.tool,
            prompt: notice.prompt,
            reason: notice.reason,
          });
        });
        return { dispose: () => {
          unsubscribeInteractions();
          unregister();
        } };
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
 * 默认 thumb 动画目录：三布局探测统一走 backend-core 的 resolvePluginAssetDir
 * （分发产物 / workspace / 桌面打包）；均不存在时返回 workspace 候选
 * （manifest 输出空清单、thumb 404，前端隐藏宠物）。
 */
export function resolveDefaultPetAssetsRoot(): string {
  return resolvePluginAssetDir({ moduleUrl: import.meta.url, relative: "assets/thumb", pluginId: PET_PLUGIN_ID });
}

/** 默认前端 UI 产物目录：三布局探测（分发/桌面=ui/，workspace=ui/dist；缺失时 bundle 404 前端降级）。 */
export function resolveDefaultPetUiRoot(): string {
  return resolvePluginAssetDir({
    moduleUrl: import.meta.url,
    relative: "ui",
    workspaceRelative: "ui/dist",
    pluginId: PET_PLUGIN_ID,
  });
}
