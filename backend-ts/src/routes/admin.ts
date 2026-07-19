import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { TenantRoleSchema } from "../contracts/control-plane/user.js";
import type { ControlPlane } from "../contracts/control-plane/index.js";
import { createTenantId, createUserId, type TenantId } from "../identity/types.js";
import { HttpError } from "../utils/errors.js";
import { hashPassword } from "../utils/password-hash.js";
import { requirePlatformAdmin } from "./platform-guard.js";
import { requireTenantMember, requireTenantRole } from "./tenant-role.js";

interface AdminRouteOptions {
  controlPlane: ControlPlane;
}

interface TenantParams {
  tenantId: string;
}

interface MemberParams extends TenantParams {
  userId: string;
}

const TenantIdSchema = z.string().regex(/^tnt_[a-z0-9]+(?:_[a-z0-9]+)*$/);
const UserIdSchema = z.string().regex(/^usr_[a-z0-9]+(?:_[a-z0-9]+)*$/);
const CreateTenantSchema = z.object({ displayName: z.string().trim().min(1) });
const InviteMemberSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(8),
  role: TenantRoleSchema.default("member"),
  displayName: z.string().trim().min(1).optional(),
});
const UpdateMemberSchema = z.object({ role: TenantRoleSchema });

export const registerAdminRoutes: FastifyPluginAsync<AdminRouteOptions> = async (app, options) => {
  app.get("/tenants", async (request) => {
    const identity = requireTenantMember(request);
    const memberships = await options.controlPlane.memberships.listByUser(identity.userId);
    const tenants = (await Promise.all(memberships.map(async (membership) => {
      const tenant = await options.controlPlane.tenants.get(membership.tenantId);
      return tenant ? { ...tenant, role: membership.role } : null;
    }))).filter((tenant) => tenant !== null);
    return { success: true, tenants };
  });

  app.post("/tenants", async (request) => {
    const actor = await requirePlatformAdmin(request, options.controlPlane);
    const input = CreateTenantSchema.parse(request.body);
    const tenantId = createTenantId(`tnt_${randomUUID().replaceAll("-", "")}`);

    const result = await options.controlPlane.provisioning.createTenantWithOwner({
      tenant: { id: tenantId, displayName: input.displayName },
      ownerUserId: actor.id,
    });
    return { success: true, tenant: { ...result.tenant, role: result.membership.role } };
  });

  app.get<{ Params: TenantParams }>("/tenants/:tenantId/members", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    requireIdentityTenant(request, tenantId);
    // 成员列表只读:member 可见(知道队友是谁),写操作(邀请/改角色/移除)仍限 admin/owner。
    requireTenantRole(request, "member");
    const memberships = await options.controlPlane.memberships.listByTenant(tenantId);
    const members = (await Promise.all(memberships.map(async (membership) => {
      const user = await options.controlPlane.users.get(membership.userId);
      return user ? { ...membership, user } : null;
    }))).filter((member) => member !== null);
    return { success: true, members };
  });

  app.post<{ Params: TenantParams }>("/tenants/:tenantId/members", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    requireIdentityTenant(request, tenantId);
    const actor = requireTenantRole(request, "admin");
    const input = InviteMemberSchema.parse(request.body);
    if (actor.role === "admin" && input.role === "owner") {
      throw new HttpError(403, "forbidden", "admin 不能授予 owner 角色");
    }

    const result = await options.controlPlane.provisioning.inviteOrAttachMember({
      tenantId,
      userId: createUserId(`usr_${randomUUID().replaceAll("-", "")}`),
      username: input.username,
      passwordHash: hashPassword(input.password),
      displayName: input.displayName ?? input.username,
      role: input.role,
    });
    return { success: true, member: { ...result.membership, user: result.user } };
  });

  app.patch<{ Params: MemberParams }>("/tenants/:tenantId/members/:userId", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    requireIdentityTenant(request, tenantId);
    requireTenantRole(request, "owner");
    const userId = createUserId(UserIdSchema.parse(request.params.userId));
    const input = UpdateMemberSchema.parse(request.body);
    const membership = await options.controlPlane.memberships.get(userId, tenantId);
    if (!membership) throw new HttpError(404, "not_found", "租户成员不存在");
    const updated = await options.controlPlane.memberships.upsert({ userId, tenantId, role: input.role });
    return { success: true, member: updated };
  });

  app.delete<{ Params: MemberParams }>("/tenants/:tenantId/members/:userId", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    requireIdentityTenant(request, tenantId);
    const actor = requireTenantRole(request, "admin");
    const userId = createUserId(UserIdSchema.parse(request.params.userId));
    if (actor.userId === userId) throw new HttpError(403, "forbidden", "不能移除自己");

    const target = await options.controlPlane.memberships.get(userId, tenantId);
    if (!target) throw new HttpError(404, "not_found", "租户成员不存在");
    await options.controlPlane.provisioning.removeMember({ tenantId, userId });
    return { success: true };
  });
};

function parseTenantId(value: string): TenantId {
  return createTenantId(TenantIdSchema.parse(value));
}

function requireIdentityTenant(request: Parameters<typeof requireTenantRole>[0], tenantId: TenantId): void {
  if (request.identity.tenantId !== tenantId) {
    throw new HttpError(403, "forbidden", "必须先切换到目标租户");
  }
}
