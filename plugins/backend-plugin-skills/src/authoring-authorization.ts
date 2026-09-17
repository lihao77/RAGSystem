import type { ToolExecContext } from "@ragsystem/agent-sdk";
import type { ControlPlane } from "@ragsystem/backend-core/contracts/control-plane/ports.js";
import type { BackendPluginResourceContribution } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { BACKEND_HOST_RESOURCES, findBackendPluginResource } from "@ragsystem/backend-core/plugins/host-resources.js";
import { createTenantId, createUserId } from "@ragsystem/backend-core/identity/types.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";

export function createSkillAuthoringAuthorization(resources: readonly BackendPluginResourceContribution[] | undefined, tenantId: string) {
  const control = findBackendPluginResource<ControlPlane>(resources, BACKEND_HOST_RESOURCES.controlPlane);
  return async (context: ToolExecContext): Promise<void> => {
    if (!control || !context.userId || (context.tenantId && context.tenantId !== tenantId)) throw forbidden();
    const userId = createUserId(context.userId);
    const tenant = createTenantId(tenantId);
    const [membership, user, organization] = await Promise.all([
      control.memberships.get(userId, tenant), control.users.get(userId), control.tenants.get(tenant),
    ]);
    if (!membership || !["admin", "owner"].includes(membership.role) || user?.status !== "active" || organization?.status !== "active") throw forbidden();
  };
}

function forbidden() { return new HttpError(403, "forbidden", "只有租户管理员可以通过 Builder 创建或修改 Skill"); }
