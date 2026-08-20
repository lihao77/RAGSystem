import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { FastifyPluginAsync } from "fastify";

import {
  ActivateLocalSceneResponseSchema,
  CreateLocalSceneRequestSchema,
  CreateLocalSceneResponseSchema,
  DeleteLocalSceneResponseSchema,
  ListLocalScenesResponseSchema,
  RenameLocalSceneRequestSchema,
  RenameLocalSceneResponseSchema,
} from "@ragsystem/api-contracts";
import type { ControlPlane } from "@ragsystem/backend-core/contracts/control-plane/index.js";
import { createTenantId, type TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { RuntimeContainerRegistry } from "@ragsystem/backend-core/services/runtime/runtime-container-registry.js";
import {
  LOCAL_ACTIVE_TENANT_SETTING,
  LOCAL_TENANT_ID,
  LOCAL_USER_ID,
} from "@ragsystem/backend-core/services/identity/index.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";

const TENANT_ID_PATTERN = /^tnt_[a-z0-9]+(?:_[a-z0-9]+)*$/;

export interface LocalSceneRouteOptions {
  readonly controlPlane: ControlPlane;
  readonly registry: RuntimeContainerRegistry;
  /** 场景数据根目录解析（本地宿主提供；非本地形态缺省，此时路由一律 404）。 */
  readonly tenantDataRoot?: (tenantId: string) => string;
  readonly enabled: boolean;
}

interface SceneParams {
  readonly id: string;
}

export const registerLocalSceneRoutes: FastifyPluginAsync<LocalSceneRouteOptions> = async (app, options) => {
  const requireEnabled = (): void => {
    if (!options.enabled) throw new HttpError(404, "not_found", "场景功能仅本地部署可用");
  };

  const parseSceneId = (value: string): TenantId => {
    if (!TENANT_ID_PATTERN.test(value)) throw new HttpError(400, "invalid_request", "场景 ID 格式无效");
    return createTenantId(value);
  };

  app.get("/", async () => {
    requireEnabled();
    const tenants = await options.controlPlane.tenants.list();
    return ListLocalScenesResponseSchema.parse({
      success: true,
      scenes: tenants,
      activeTenantId: await resolveActiveSceneId(options.controlPlane),
    });
  });

  app.post("/", async (request) => {
    requireEnabled();
    const input = CreateLocalSceneRequestSchema.parse(request.body);
    await ensureLocalUser(options.controlPlane);
    const tenantId = createTenantId(`tnt_${randomUUID().replaceAll("-", "")}`);
    const result = await options.controlPlane.provisioning.createTenantWithOwner({
      tenant: { id: tenantId, displayName: input.displayName },
      ownerUserId: LOCAL_USER_ID,
    });
    return CreateLocalSceneResponseSchema.parse({ success: true, scene: result.tenant });
  });

  app.post<{ Params: SceneParams }>("/:id/activate", async (request) => {
    requireEnabled();
    const tenantId = parseSceneId(request.params.id);
    const tenant = await options.controlPlane.tenants.get(tenantId);
    if (!tenant) throw new HttpError(404, "not_found", "场景不存在");
    if (tenant.status !== "active") throw new HttpError(409, "conflict", "场景已停用，无法切换");
    await ensureLocalUser(options.controlPlane);
    await options.controlPlane.memberships.upsert({ userId: LOCAL_USER_ID, tenantId, role: "owner" });
    await options.controlPlane.settings.set(LOCAL_ACTIVE_TENANT_SETTING, tenantId);
    return ActivateLocalSceneResponseSchema.parse({ success: true, tenantId });
  });

  app.patch<{ Params: SceneParams }>("/:id", async (request) => {
    requireEnabled();
    const tenantId = parseSceneId(request.params.id);
    const input = RenameLocalSceneRequestSchema.parse(request.body);
    const tenant = await options.controlPlane.tenants.get(tenantId);
    if (!tenant) throw new HttpError(404, "not_found", "场景不存在");
    await options.controlPlane.tenants.updateName(tenantId, input.displayName);
    const updated = await options.controlPlane.tenants.get(tenantId);
    return RenameLocalSceneResponseSchema.parse({
      success: true,
      scene: updated ?? { ...tenant, displayName: input.displayName },
    });
  });

  app.delete<{ Params: SceneParams }>("/:id", async (request) => {
    requireEnabled();
    const tenantId = parseSceneId(request.params.id);
    const tenant = await options.controlPlane.tenants.get(tenantId);
    if (!tenant) throw new HttpError(404, "not_found", "场景不存在");
    // 默认场景是身份提供者的回落目标，删除会使回落不变量破裂（活动场景失效时全后端不可用）。
    if (tenantId === LOCAL_TENANT_ID) throw new HttpError(409, "conflict", "默认场景不可删除");
    const active = await resolveActiveSceneId(options.controlPlane);
    if (active === tenantId) throw new HttpError(409, "conflict", "不能删除当前场景，请先切换到其他场景");
    const tenants = await options.controlPlane.tenants.list();
    if (tenants.length <= 1) throw new HttpError(409, "conflict", "至少保留一个场景");
    // 先删控制库租户行：registry 的 acquire 校验以租户行为准，删行后即拒绝新请求重建运行时，
    // 闭合"关闭运行时 → 删行"之间在途请求重开 SQLite 与 fs.rm 抢句柄的竞态窗口。
    const provisioning = options.controlPlane.provisioning;
    if (provisioning.removeTenant) {
      await provisioning.removeTenant({ tenantId });
    } else {
      await options.controlPlane.tenants.delete(tenantId);
    }
    await options.registry.closeTenant(tenantId);
    const dataRoot = options.tenantDataRoot?.(tenantId);
    if (dataRoot) {
      try {
        await fs.promises.rm(dataRoot, { recursive: true, force: true });
      } catch (error) {
        // 租户行已删除，目录清理失败不应让端点报错；残留目录由用户手动清理。
        request.log.warn({ error, tenantId }, "场景数据目录清理失败");
      }
    }
    return DeleteLocalSceneResponseSchema.parse({ success: true });
  });
};

/** 生产环境由 SceneLocalIdentityProvider 启动时创建本地隐式用户；此处幂等兜底，保证路由可独立装配。 */
async function ensureLocalUser(controlPlane: ControlPlane): Promise<void> {
  const existing = await controlPlane.users.get(LOCAL_USER_ID);
  if (!existing) {
    await controlPlane.users.create({
      id: LOCAL_USER_ID,
      displayName: "Local User",
      platformRole: "admin",
    });
  }
}

/** 与 SceneLocalIdentityProvider 同规则：设置缺失或指向无效/已停用租户时回落默认场景。 */
async function resolveActiveSceneId(controlPlane: ControlPlane): Promise<TenantId> {
  const stored = await controlPlane.settings.get(LOCAL_ACTIVE_TENANT_SETTING);
  if (stored) {
    try {
      const tenant = await controlPlane.tenants.get(createTenantId(stored));
      if (tenant?.status === "active") return tenant.id;
    } catch {
      // 设置值不满足租户 ID 格式时按未设置处理。
    }
  }
  return LOCAL_TENANT_ID;
}
