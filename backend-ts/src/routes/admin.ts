import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import { createTenantId, createUserId, type TenantId } from "../identity/types.js";
import type { SessionTokenService } from "../services/runtime/session-token-service.js";
import type { ControlMembership, ControlStore } from "../services/stores/control-store/index.js";
import { HttpError } from "../utils/errors.js";
import { hashPassword } from "../utils/password-hash.js";

type TenantRole = "owner" | "admin" | "member";

interface AdminRuntimeView {
  sessionTokens: SessionTokenService | undefined;
}

interface AdminRouteOptions {
  controlStore: ControlStore;
  runtime: AdminRuntimeView;
}

interface TenantParams {
  tenantId: string;
}

interface MemberParams extends TenantParams {
  userId: string;
}

const ROLE_LEVEL: Record<TenantRole, number> = {
  owner: 2,
  admin: 1,
  member: 0,
};

const TenantRoleSchema = z.enum(["owner", "admin", "member"]);
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
    const claims = requireSessionTokens(options.runtime.sessionTokens).requireBearer(request);
    const tenants = options.controlStore.listMembershipsByUser(claims.sub).flatMap((membership) => {
      const tenant = options.controlStore.getTenant(membership.tenantId);
      return tenant ? [{ ...tenant, role: membership.role }] : [];
    });
    return { success: true, tenants };
  });

  app.post("/tenants", async (request) => {
    const sessionTokens = requireSessionTokens(options.runtime.sessionTokens);
    const claims = sessionTokens.requireBearer(request);
    requireTenantRole(options.controlStore, sessionTokens, request, claims.tenant_id, "owner");
    const input = CreateTenantSchema.parse(request.body);
    const tenantId = createTenantId(`tnt_${randomUUID().replaceAll("-", "")}`);

    options.controlStore.db.exec("BEGIN IMMEDIATE");
    try {
      const tenant = options.controlStore.createTenant({ id: tenantId, displayName: input.displayName });
      const membership = options.controlStore.upsertMembership({ userId: claims.sub, tenantId, role: "owner" });
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
    requireTenantRole(
      options.controlStore,
      requireSessionTokens(options.runtime.sessionTokens),
      request,
      tenantId,
      "member",
    );
    const members = options.controlStore.listMembershipsByTenant(tenantId).flatMap((membership) => {
      const user = options.controlStore.getUser(membership.userId);
      return user ? [{ ...membership, user }] : [];
    });
    return { success: true, members };
  });

  app.post<{ Params: TenantParams }>("/tenants/:tenantId/members", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    const actor = requireTenantRole(
      options.controlStore,
      requireSessionTokens(options.runtime.sessionTokens),
      request,
      tenantId,
      "admin",
    );
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
    requireTenantRole(
      options.controlStore,
      requireSessionTokens(options.runtime.sessionTokens),
      request,
      tenantId,
      "owner",
    );
    const userId = createUserId(UserIdSchema.parse(request.params.userId));
    const input = UpdateMemberSchema.parse(request.body);
    const membership = options.controlStore.getMembership(userId, tenantId);
    if (!membership) throw new HttpError(404, "not_found", "租户成员不存在");
    if (membership.role === "owner" && input.role !== "owner") {
      const ownerCount = options.controlStore.listMembershipsByTenant(tenantId)
        .filter((candidate) => candidate.role === "owner").length;
      if (ownerCount === 1) throw new HttpError(403, "forbidden", "不能降级租户唯一 owner");
    }
    const updated = options.controlStore.upsertMembership({ userId, tenantId, role: input.role });
    return { success: true, member: updated };
  });

  app.delete<{ Params: MemberParams }>("/tenants/:tenantId/members/:userId", async (request) => {
    const tenantId = parseTenantId(request.params.tenantId);
    const actor = requireTenantRole(
      options.controlStore,
      requireSessionTokens(options.runtime.sessionTokens),
      request,
      tenantId,
      "admin",
    );
    const userId = createUserId(UserIdSchema.parse(request.params.userId));
    if (actor.userId === userId) throw new HttpError(403, "forbidden", "不能移除自己");

    options.controlStore.db.exec("BEGIN IMMEDIATE");
    try {
      const target = options.controlStore.getMembership(userId, tenantId);
      if (!target) throw new HttpError(404, "not_found", "租户成员不存在");
      if (target.role === "owner") {
        const ownerCount = options.controlStore.listMembershipsByTenant(tenantId)
          .filter((membership) => membership.role === "owner").length;
        if (ownerCount === 1) throw new HttpError(403, "forbidden", "不能移除租户唯一 owner");
      }
      options.controlStore.deleteMembership(userId, tenantId);
      options.controlStore.db.exec("COMMIT");
      return { success: true };
    } catch (error) {
      options.controlStore.db.exec("ROLLBACK");
      throw error;
    }
  });
};

export function requireTenantRole(
  controlStore: ControlStore,
  sessionTokens: SessionTokenService,
  request: FastifyRequest,
  tenantId: TenantId,
  minRole: TenantRole,
): { userId: ControlMembership["userId"]; tenantId: TenantId; role: string } {
  const claims = sessionTokens.requireBearer(request);
  const membership = controlStore.getMembership(claims.sub, tenantId);
  const role = membership ? parseStoredRole(membership.role) : null;
  if (!membership || !role || ROLE_LEVEL[role] < ROLE_LEVEL[minRole]) {
    throw new HttpError(403, "forbidden", "无权执行该租户操作");
  }
  return { userId: membership.userId, tenantId: membership.tenantId, role: membership.role };
}

function requireSessionTokens(service: SessionTokenService | undefined): SessionTokenService {
  if (!service) throw new HttpError(503, "auth_unavailable", "password 认证未在当前启动 profile 中启用");
  return service;
}

function parseTenantId(value: string): TenantId {
  return createTenantId(TenantIdSchema.parse(value));
}

function parseStoredRole(role: string): TenantRole | null {
  const parsed = TenantRoleSchema.safeParse(role);
  return parsed.success ? parsed.data : null;
}
