import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { TenantRoleSchema } from "../contracts/user.js";
import { createTenantId, createUserId, type TenantId } from "../identity/types.js";
import type { ControlStore } from "../services/stores/control-store/index.js";
import { HttpError } from "../utils/errors.js";
import { hashPassword } from "../utils/password-hash.js";
import { requireTenantMember, requireTenantOwner, requireTenantRole } from "./tenant-role.js";

interface AdminRouteOptions {
  controlStore: ControlStore;
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
    const tenants = options.controlStore.listMembershipsByUser(identity.userId).flatMap((membership) => {
      const tenant = options.controlStore.getTenant(membership.tenantId);
      return tenant ? [{ ...tenant, role: membership.role }] : [];
    });
    return { success: true, tenants };
  });

  app.post("/tenants", async (request) => {
    const identity = requireTenantOwner(request);
    const input = CreateTenantSchema.parse(request.body);
    const tenantId = createTenantId(`tnt_${randomUUID().replaceAll("-", "")}`);

    options.controlStore.db.exec("BEGIN IMMEDIATE");
    try {
      const tenant = options.controlStore.createTenant({ id: tenantId, displayName: input.displayName });
      const membership = options.controlStore.upsertMembership({ userId: identity.userId, tenantId, role: "owner" });
      options.controlStore.db.exec("COMMIT");
      return { success: true, tenant: { ...tenant, role: membership.role } };
    } catch (error) {
      options.controlStore.db.exec("ROLLBACK");
      throw error;
    }
  });

  app.get<{ Params: TenantParams }>("/tenants/:tenantId/members", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    // 成员列表只读:member 可见(知道队友是谁),写操作(邀请/改角色/移除)仍限 admin/owner。
    requireTenantRole(request, "member");
    const members = options.controlStore.listMembershipsByTenant(tenantId).flatMap((membership) => {
      const user = options.controlStore.getUser(membership.userId);
      return user ? [{ ...membership, user }] : [];
    });
    return { success: true, members };
  });

  app.post<{ Params: TenantParams }>("/tenants/:tenantId/members", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    const actor = requireTenantRole(request, "admin");
    const input = InviteMemberSchema.parse(request.body);
    if (actor.role === "admin" && input.role === "owner") {
      throw new HttpError(403, "forbidden", "admin 不能授予 owner 角色");
    }

    options.controlStore.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = options.controlStore.getUserByUsername(input.username);
      const user = existing ?? options.controlStore.createUser({
        id: createUserId(`usr_${randomUUID().replaceAll("-", "")}`),
        displayName: input.displayName ?? input.username,
        username: input.username,
        password_hash: hashPassword(input.password),
      });
      const membership = options.controlStore.upsertMembership({ userId: user.id, tenantId, role: input.role });
      options.controlStore.db.exec("COMMIT");
      return { success: true, member: { ...membership, user } };
    } catch (error) {
      options.controlStore.db.exec("ROLLBACK");
      throw error;
    }
  });

  app.patch<{ Params: MemberParams }>("/tenants/:tenantId/members/:userId", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    requireTenantRole(request, "owner");
    const userId = createUserId(UserIdSchema.parse(request.params.userId));
    const input = UpdateMemberSchema.parse(request.body);
    const membership = options.controlStore.getMembership(userId, tenantId);
    if (!membership) throw new HttpError(404, "not_found", "租户成员不存在");
    const updated = options.controlStore.upsertMembership({ userId, tenantId, role: input.role });
    return { success: true, member: updated };
  });

  app.delete<{ Params: MemberParams }>("/tenants/:tenantId/members/:userId", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    const actor = requireTenantRole(request, "admin");
    const userId = createUserId(UserIdSchema.parse(request.params.userId));
    if (actor.userId === userId) throw new HttpError(403, "forbidden", "不能移除自己");

    options.controlStore.db.exec("BEGIN IMMEDIATE");
    try {
      const target = options.controlStore.getMembership(userId, tenantId);
      if (!target) throw new HttpError(404, "not_found", "租户成员不存在");
      options.controlStore.deleteMembership(userId, tenantId);
      options.controlStore.db.exec("COMMIT");
      return { success: true };
    } catch (error) {
      options.controlStore.db.exec("ROLLBACK");
      throw error;
    }
  });
};

function parseTenantId(value: string): TenantId {
  return createTenantId(TenantIdSchema.parse(value));
}
