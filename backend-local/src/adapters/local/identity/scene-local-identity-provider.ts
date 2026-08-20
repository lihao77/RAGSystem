import type { FastifyRequest } from "fastify";

import {
  createTenantId,
  type RequestIdentity,
  type TenantId,
} from "@ragsystem/backend-core/identity/types.js";
import type { ControlPlane } from "@ragsystem/backend-core/contracts/control-plane/index.js";
import type { IdentityProvider } from "@ragsystem/backend-core/services/identity/index.js";
import { LOCAL_ACTIVE_TENANT_SETTING, LOCAL_TENANT_ID, LOCAL_USER_ID } from "@ragsystem/backend-core/services/identity/index.js";

/**
 * 本地部署的身份提供者：固定隐式用户 + 场景（租户）感知。
 *
 * 场景切换为服务端全局生效——切换端点写 LOCAL_ACTIVE_TENANT_SETTING，
 * 本提供者每请求读取；设置缺失或指向不存在/已暂停租户（如场景被删除）时
 * 回落默认场景 tnt_local，保证本地后端始终可解析出可用身份。
 */
export class SceneLocalIdentityProvider implements IdentityProvider {
  private initialization: Promise<void> | null = null;

  constructor(private readonly controlPlane: ControlPlane) {}

  async resolve(_request: FastifyRequest): Promise<RequestIdentity> {
    await this.initialize();
    return {
      userId: LOCAL_USER_ID,
      tenantId: await this.resolveActiveTenantId(),
      role: "owner",
      permissions: ["*"],
      platformRole: "admin",
    };
  }

  async initialize(): Promise<void> {
    // 失败不缓存：瞬时 DB 异常不应让 rejected promise 常驻，导致本地身份解析永久失败。
    this.initialization ??= this.initializeDefaults().catch((error: unknown) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  private async resolveActiveTenantId(): Promise<TenantId> {
    const stored = await this.controlPlane.settings.get(LOCAL_ACTIVE_TENANT_SETTING);
    if (stored) {
      try {
        const tenant = await this.controlPlane.tenants.get(createTenantId(stored));
        if (tenant?.status === "active") return tenant.id;
      } catch {
        // 设置值不满足租户 ID 格式时按未设置处理，回落默认场景。
      }
    }
    return LOCAL_TENANT_ID;
  }

  private async initializeDefaults(): Promise<void> {
    await this.controlPlane.provisioning.ensureLocalIdentity({
      tenant: { id: LOCAL_TENANT_ID, displayName: "Local" },
      user: { id: LOCAL_USER_ID, displayName: "Local User", platformRole: "admin" },
      role: "owner",
    });
  }
}
