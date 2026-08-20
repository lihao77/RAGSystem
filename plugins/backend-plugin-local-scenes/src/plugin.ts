import type { BackendPlugin } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import {
  BACKEND_HOST_RESOURCES,
  requireBackendPluginResource,
  type BackendDeploymentResource,
} from "@ragsystem/backend-core/plugins/host-resources.js";
import type { ControlPlane } from "@ragsystem/backend-core/contracts/control-plane/index.js";

import { registerLocalSceneRoutes } from "./scenes.js";

export const LOCAL_SCENES_PLUGIN_ID = "@ragsystem/backend-plugin-local-scenes";

/**
 * 本地"场景"管理插件：场景即租户（独立数据目录与运行库），无成员语义。
 *
 * 依赖全部来自路由装配期的宿主上下文（install context 的 host：registry + 合并资源池），
 * 装配时序晚于 initializeApplication，无需手工闭包暂存。仅本地部署的插件清单装载本插件；
 * 若被其他形态装载，路由一律 404（tenantDataRoot 资源也仅本地提供，按形态延迟取用）。
 *
 * 启用条件除 deployment=local 外还要求 auth=local：场景切换依赖 SceneLocalIdentityProvider
 * 消费 LOCAL_ACTIVE_TENANT_SETTING，password 认证下该链路不存在——activate 无效而删除真实，
 * 语义割裂，故一并禁用。settings 缺省 auth_mode 与部署默认一致按 local 处理。
 */
export function createLocalScenesPlugin(): BackendPlugin {
  return {
    manifest: { id: LOCAL_SCENES_PLUGIN_ID, version: "0.1.0" },
    register(context) {
      context.routes.register("public", "/api/local/scenes", async (app, installContext) => {
        const host = installContext.host;
        if (!host) throw new Error("Local scenes plugin requires route host context");
        const controlPlane = requireBackendPluginResource<ControlPlane>(host.resources, BACKEND_HOST_RESOURCES.controlPlane);
        const deployment = requireBackendPluginResource<BackendDeploymentResource>(host.resources, BACKEND_HOST_RESOURCES.deployment);
        const authMode = (await controlPlane.settings.get("auth_mode")) ?? "local";
        const enabled = deployment.kind === "local" && authMode === "local";
        const tenantDataRoot = enabled
          ? requireBackendPluginResource<(tenantId: string) => string>(host.resources, BACKEND_HOST_RESOURCES.tenantDataRoot)
          : undefined;
        await app.register(registerLocalSceneRoutes, {
          controlPlane,
          registry: host.registry,
          ...(tenantDataRoot !== undefined ? { tenantDataRoot } : {}),
          enabled,
        });
      });
    },
  };
}
