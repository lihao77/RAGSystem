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
import type { ControlPlane } from "../contracts/control-plane/index.js";
import type { SessionTokenService } from "../services/runtime/session-token-service.js";
import { HttpError } from "../utils/errors.js";
import { hashPassword, verifyPassword } from "../utils/password-hash.js";

interface AuthRuntimeView {
  profile: DeploymentProfile;
  sessionTokens: SessionTokenService | undefined;
}

interface BaseAuthRouteOptions {
  controlPlane: ControlPlane;
  runtime: AuthRuntimeView;
}

interface InstallRouteOptions extends BaseAuthRouteOptions {
  refreshProfile: () => Promise<DeploymentProfile>;
  validateProfileSettings: (settings: Readonly<Record<string, string>>) => void;
}

export const registerInstallRoutes: FastifyPluginAsync<InstallRouteOptions> = async (app, options) => {
  app.post("/install", async (request) => {
    const input = InstallRequestSchema.parse(request.body);
    if (input.deployment === "saas" && !input.admin) {
      throw new HttpError(400, "invalid_request", "SaaS 安装必须配置管理员账号");
    }

    const deploymentMode = input.deployment === "single" ? "local" : "saas";
    const authMode = input.deployment === "single" ? "local" : "password";
    const tenancyMode = input.deployment === "single" ? "single" : (input.tenancy ?? "single");
    const configuredSaaSProfile = options.runtime.profile.deployment === "saas"
      ? options.runtime.profile
      : null;
    const executionMode = input.deployment === "single"
      ? "local"
      : configuredSaaSProfile?.execution ?? "remote";
    const storageMode = input.deployment === "single"
      ? "sqlite"
      : configuredSaaSProfile?.storage ?? "sqlite-per-tenant";
    const tenantId = createTenantId(input.deployment === "single" ? "tnt_local" : "tnt_default");
    const tenantName = input.tenantDisplayName ?? (input.deployment === "single" ? "Local" : "Default");

    const settings = {
      deployment_mode: deploymentMode,
      auth_mode: authMode,
      tenancy_mode: tenancyMode,
      execution_mode: executionMode,
      storage_mode: storageMode,
      ui_mode: input.deployment === "single" ? "local" : "saas",
      installed: "true",
    };
    options.validateProfileSettings(settings);
    await options.controlPlane.provisioning.install({
      tenant: { id: tenantId, displayName: tenantName },
      ...(input.deployment === "saas" && input.admin
        ? {
            admin: {
              id: createUserId(`usr_${randomUUID().replaceAll("-", "")}`),
              displayName: input.admin.username,
              username: input.admin.username,
              passwordHash: hashPassword(input.admin.password),
            },
          }
        : {}),
      settings,
    });

    const profile = await options.refreshProfile();
    return { ...profile, installed: true, restart_required: false, platformRole: "admin" };
  });
};

export const registerAuthRoutes: FastifyPluginAsync<BaseAuthRouteOptions> = async (app, options) => {
  app.post("/login", async (request) => {
    const sessionTokens = requireSessionTokens(options.runtime.sessionTokens);
    const input = LoginRequestSchema.parse(request.body);
    const user = await options.controlPlane.users.findCredentialsByUsername(input.username);
    if (!user?.passwordHash || !verifyPassword(input.password, user.passwordHash)) {
      throw new HttpError(401, "unauthorized", "用户名或密码错误");
    }
    if (user.status === "disabled") throw new HttpError(401, "unauthorized", "用户已被禁用");
    const membership = await options.controlPlane.memberships.findFirstActiveForLogin(
      user.id,
      user.platformRole === "admin",
    );
    if (!membership) throw new HttpError(401, "unauthorized", "用户未加入可用租户");
    const issued = sessionTokens.issueToken({
      userId: user.id,
      tenantId: membership.tenantId,
      role: membership.role,
      ...(user.platformRole ? { platformRole: user.platformRole } : {}),
    });
    await options.controlPlane.sessions.record({
      jti: issued.claims.jti,
      userId: user.id,
      tenantId: membership.tenantId,
      issuedAt: issued.claims.iat,
      expiresAt: issued.claims.exp,
    });
    return AuthSessionSchema.parse({
      token: issued.token,
      expires_at: issued.expires_at,
      user: { id: user.id, displayName: user.displayName },
      tenantId: membership.tenantId,
      role: membership.role,
      platformRole: user.platformRole,
    });
  });

  app.post("/switch-tenant", async (request) => {
    const sessionTokens = requireSessionTokens(options.runtime.sessionTokens);
    const claims = await sessionTokens.requireBearer(request);
    const input = SwitchTenantRequestSchema.parse(request.body);
    const tenantId = createTenantId(input.tenantId);
    const membership = await options.controlPlane.memberships.get(claims.sub, tenantId);
    if (!membership) throw new HttpError(403, "forbidden", "用户不是该租户成员");
    const user = await options.controlPlane.users.get(claims.sub);
    const tenant = await options.controlPlane.tenants.get(tenantId);
    if (!user || user.status === "disabled") throw new HttpError(401, "unauthorized", "session identity 无效");
    if (!tenant || tenant.status === "suspended") throw new HttpError(401, "unauthorized", "租户已暂停");
    const issued = sessionTokens.issueToken({
      userId: user.id,
      tenantId,
      role: membership.role,
      ...(user.platformRole ? { platformRole: user.platformRole } : {}),
    });
    await options.controlPlane.sessions.record({
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
    const claims = await requireSessionTokens(options.runtime.sessionTokens).requireBearer(request);
    const [user, membership, tenant] = await Promise.all([
      options.controlPlane.users.get(claims.sub),
      options.controlPlane.memberships.get(claims.sub, claims.tenant_id),
      options.controlPlane.tenants.get(claims.tenant_id),
    ]);
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
    const claims = await sessionTokens.requireBearer(request);
    await sessionTokens.revoke(claims.jti);
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
