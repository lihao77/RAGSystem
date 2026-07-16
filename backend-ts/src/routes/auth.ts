import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import {
  AuthIdentitySchema,
  AuthSessionSchema,
  InstallRequestSchema,
  LoginRequestSchema,
  LogoutResponseSchema,
  SwitchTenantRequestSchema,
} from "@ragsystem/api-contracts";

import { createTenantId, createUserId, type DeploymentProfile } from "../identity/types.js";
import type { SessionTokenService } from "../services/runtime/session-token-service.js";
import type { ControlStore } from "../services/stores/control-store/index.js";
import { HttpError } from "../utils/errors.js";
import { hashPassword, verifyPassword } from "../utils/password-hash.js";

interface AuthRuntimeView {
  profile: DeploymentProfile;
  sessionTokens: SessionTokenService | undefined;
}

interface BaseAuthRouteOptions {
  controlStore: ControlStore;
  runtime: AuthRuntimeView;
}

interface InstallRouteOptions extends BaseAuthRouteOptions {
  refreshProfile: () => DeploymentProfile;
}

export const registerInstallRoutes: FastifyPluginAsync<InstallRouteOptions> = async (app, options) => {
  app.post("/install", async (request) => {
    if (options.controlStore.getSetting("installed") === "true") {
      throw new HttpError(409, "already_installed", "系统已完成安装");
    }
    const input = InstallRequestSchema.parse(request.body);
    if (input.deployment === "saas" && !input.admin) {
      throw new HttpError(400, "invalid_request", "SaaS 安装必须配置管理员账号");
    }

    const deploymentMode = input.deployment === "single" ? "local" : "saas";
    const authMode = input.deployment === "single" ? "local" : "password";
    const tenancyMode = input.deployment === "single" ? "single" : (input.tenancy ?? "single");
    const tenantId = createTenantId(input.deployment === "single" ? "tnt_local" : "tnt_default");
    const tenantName = input.tenantDisplayName ?? (input.deployment === "single" ? "Local" : "Default");

    options.controlStore.db.exec("BEGIN IMMEDIATE");
    try {
      if (!options.controlStore.getTenant(tenantId)) {
        options.controlStore.createTenant({ id: tenantId, displayName: tenantName });
      }
      if (input.deployment === "saas" && input.admin) {
        const userId = createUserId(`usr_${randomUUID().replaceAll("-", "")}`);
        options.controlStore.createUser({
          id: userId,
          displayName: input.admin.username,
          username: input.admin.username,
          password_hash: hashPassword(input.admin.password),
          platform_role: "admin",
        });
        options.controlStore.upsertMembership({ userId, tenantId, role: "owner" });
      }
      options.controlStore.setSetting("deployment_mode", deploymentMode);
      options.controlStore.setSetting("auth_mode", authMode);
      options.controlStore.setSetting("tenancy_mode", tenancyMode);
      options.controlStore.setSetting("execution_mode", input.deployment === "single" ? "local" : "remote");
      options.controlStore.setSetting("storage_mode", input.deployment === "single" ? "sqlite" : "sqlite-per-tenant");
      options.controlStore.setSetting("ui_mode", input.deployment === "single" ? "local" : "saas");
      options.controlStore.setSetting("installed", "true");
      options.controlStore.db.exec("COMMIT");
    } catch (error) {
      options.controlStore.db.exec("ROLLBACK");
      throw error;
    }

    const profile = options.refreshProfile();
    return { ...profile, installed: true, restart_required: false, platformRole: "admin" };
  });
};

export const registerAuthRoutes: FastifyPluginAsync<BaseAuthRouteOptions> = async (app, options) => {
  app.post("/login", async (request) => {
    const sessionTokens = requireSessionTokens(options.runtime.sessionTokens);
    const input = LoginRequestSchema.parse(request.body);
    const publicUser = options.controlStore.getUserByUsername(input.username);
    const user = publicUser ? options.controlStore.getUserWithCredentials(publicUser.id) : null;
    if (!user?.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
      throw new HttpError(401, "unauthorized", "用户名或密码错误");
    }
    if (user.status === "disabled") throw new HttpError(401, "unauthorized", "用户已被禁用");
    const memberships = options.controlStore.db.prepare(`
      SELECT memberships.tenant_id, memberships.role
      FROM memberships
      JOIN tenants ON tenants.id=memberships.tenant_id
      WHERE memberships.user_id=? AND tenants.status='active'
      ORDER BY memberships.tenant_id LIMIT 1
    `).all(user.id) as unknown as Array<{ tenant_id: ReturnType<typeof createTenantId>; role: string }>;
    const membership = memberships[0] ?? (user.platformRole === "admin"
      ? options.controlStore.db.prepare("SELECT id AS tenant_id, 'member' AS role FROM tenants ORDER BY id LIMIT 1").get() as { tenant_id: ReturnType<typeof createTenantId>; role: string } | undefined
      : undefined);
    if (!membership) throw new HttpError(401, "unauthorized", "用户未加入可用租户");
    const issued = sessionTokens.issueToken({
      userId: user.id,
      tenantId: membership.tenant_id,
      role: membership.role,
      ...(user.platformRole ? { platformRole: user.platformRole } : {}),
    });
    options.controlStore.recordSession({
      jti: issued.claims.jti,
      userId: user.id,
      tenantId: membership.tenant_id,
      issuedAt: issued.claims.iat,
      expiresAt: issued.claims.exp,
    });
    return AuthSessionSchema.parse({
      token: issued.token,
      expires_at: issued.expires_at,
      user: { id: user.id, displayName: user.displayName },
      tenantId: membership.tenant_id,
      role: membership.role,
      platformRole: user.platformRole,
    });
  });

  app.post("/switch-tenant", async (request) => {
    const sessionTokens = requireSessionTokens(options.runtime.sessionTokens);
    const claims = sessionTokens.requireBearer(request);
    const input = SwitchTenantRequestSchema.parse(request.body);
    const tenantId = createTenantId(input.tenantId);
    const membership = options.controlStore.getMembership(claims.sub, tenantId);
    if (!membership) throw new HttpError(403, "forbidden", "用户不是该租户成员");
    const user = options.controlStore.getUser(claims.sub);
    const tenant = options.controlStore.getTenant(tenantId);
    if (!user || user.status === "disabled") throw new HttpError(401, "unauthorized", "session identity 无效");
    if (!tenant || tenant.status === "suspended") throw new HttpError(401, "unauthorized", "租户已暂停");
    const issued = sessionTokens.issueToken({
      userId: user.id,
      tenantId,
      role: membership.role,
      ...(user.platformRole ? { platformRole: user.platformRole } : {}),
    });
    options.controlStore.recordSession({
      jti: issued.claims.jti,
      userId: user.id,
      tenantId,
      issuedAt: issued.claims.iat,
      expiresAt: issued.claims.exp,
    });
    return AuthSessionSchema.parse({
      token: issued.token,
      expires_at: issued.expires_at,
      user: { id: user.id, displayName: user.displayName },
      tenantId,
      role: membership.role,
      platformRole: user.platformRole,
    });
  });

  app.get("/me", async (request) => {
    const claims = requireSessionTokens(options.runtime.sessionTokens).requireBearer(request);
    const user = options.controlStore.getUser(claims.sub);
    const membership = options.controlStore.getMembership(claims.sub, claims.tenant_id);
    const tenant = options.controlStore.getTenant(claims.tenant_id);
    if (!user || user.status === "disabled") throw new HttpError(401, "unauthorized", "session identity 无效");
    if (membership && membership.role === claims.role && tenant?.status === "active") {
      return AuthIdentitySchema.parse({ user: { id: user.id, displayName: user.displayName }, userId: user.id, tenantId: membership.tenantId, role: membership.role, permissions: rolePermissions(membership.role), platformRole: user.platformRole });
    }
    if (user.platformRole === "admin") {
      return AuthIdentitySchema.parse({ user: { id: user.id, displayName: user.displayName }, userId: user.id, tenantId: claims.tenant_id, role: claims.role, permissions: [], platformRole: user.platformRole });
    }
    throw new HttpError(401, "unauthorized", tenant?.status === "suspended" ? "租户已暂停" : "session identity 无效");
  });

  app.post("/logout", async (request) => {
    const sessionTokens = requireSessionTokens(options.runtime.sessionTokens);
    const claims = sessionTokens.requireBearer(request);
    sessionTokens.revoke(claims.jti);
    return LogoutResponseSchema.parse({ success: true });
  });
};

function requireSessionTokens(service: SessionTokenService | undefined): SessionTokenService {
  if (!service) throw new HttpError(503, "auth_unavailable", "password 认证未在当前启动 profile 中启用");
  return service;
}

function rolePermissions(role: string): string[] {
  return role === "owner" || role === "admin" ? ["*"] : [];
}
