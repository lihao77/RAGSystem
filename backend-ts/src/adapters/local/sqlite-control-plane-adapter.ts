import type {
  ControlPlane,
  ControlPlaneProvisioning,
  ControlTenant,
  ControlUser,
  MembershipDirectory,
  TenantDirectory,
  UserDirectory,
} from "../../contracts/control-plane/index.js";
import { TenantRoleSchema } from "../../contracts/user.js";
import { createTenantId } from "../../identity/types.js";
import {
  CONTROL_LATEST_SCHEMA_VERSION,
  ControlStore,
  createControlStore,
} from "./sqlite/control-store/index.js";
import { HttpError } from "../../utils/errors.js";

export interface SqliteControlPlaneAdapterOptions {
  closeStore?: boolean;
}

/** Async control-plane boundary backed by the Local deployment's SQLite store. */
export class SqliteControlPlaneAdapter implements ControlPlane {
  readonly tenants: TenantDirectory;
  readonly users: UserDirectory;
  readonly memberships: MembershipDirectory;
  readonly provisioning: ControlPlaneProvisioning;
  private closed = false;
  readonly ownsStore: boolean;

  constructor(
    readonly store: ControlStore,
    options: SqliteControlPlaneAdapterOptions = {},
  ) {
    this.ownsStore = options.closeStore ?? false;
    this.tenants = {
      create: async (input) => this.store.createTenant(input),
      get: async (id) => this.store.getTenant(id),
      list: async () => this.store.listTenants(),
      listPage: async (input = {}) => this.store.listAllTenants(input),
      updateName: async (id, displayName) => this.store.updateTenant(id, displayName),
      setStatus: async (id, status) => this.store.setTenantStatus(id, status),
      delete: async (id) => this.store.deleteTenant(id),
    };
    this.users = {
      create: async (input) => this.store.createUser({
        id: input.id,
        displayName: input.displayName,
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.passwordHash !== undefined ? { password_hash: input.passwordHash } : {}),
        ...(input.platformRole !== undefined ? { platform_role: input.platformRole } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      }),
      get: async (id) => this.store.getUser(id),
      findByUsername: async (username) => this.store.getUserByUsername(username),
      findCredentialsByUsername: async (username) => {
        const user = this.store.getUserByUsername(username);
        return user ? this.store.getUserWithCredentials(user.id) : null;
      },
      list: async () => this.store.listUsers(),
      listPage: async (input = {}) => this.store.listAllUsers(input),
      updateName: async (id, displayName) => this.store.updateUser(id, displayName),
      setStatus: async (id, status) => this.store.setUserStatus(id, status),
      setPlatformRole: async (id, role) => this.store.setUserPlatformRole(id, role),
      delete: async (id) => this.store.deleteUser(id),
    };
    this.memberships = {
      upsert: async (input) => this.store.upsertMembership(input),
      get: async (userId, tenantId) => this.store.getMembership(userId, tenantId),
      listByTenant: async (tenantId) => this.store.listMembershipsByTenant(tenantId),
      listByUser: async (userId) => this.store.listMembershipsByUser(userId),
      delete: async (userId, tenantId) => this.store.deleteMembership(userId, tenantId),
      findFirstActiveForLogin: async (userId, allowPlatformFallback) => this.findFirstActiveForLogin(userId, allowPlatformFallback),
    };
    this.provisioning = {
      install: async (input) => this.install(input),
      createTenantWithOwner: async (input) => this.createTenantWithOwner(input),
      inviteOrAttachMember: async (input) => this.inviteOrAttachMember(input),
      removeMember: async (input) => this.store.transaction(() => this.store.deleteMembership(input.userId, input.tenantId)),
      ensureLocalIdentity: async (input) => this.store.transaction(() => {
        const tenant = this.store.getTenant(input.tenant.id)
          ?? this.store.createTenant(input.tenant);
        const existingUser = this.store.getUser(input.user.id);
        const user = existingUser ?? this.store.createUser({
          id: input.user.id,
          displayName: input.user.displayName,
          platform_role: input.user.platformRole,
        });
        if (existingUser) {
          this.store.setUserStatus(input.user.id, "active");
          this.store.setUserPlatformRole(input.user.id, input.user.platformRole);
        }
        const membership = this.store.upsertMembership({
          userId: input.user.id,
          tenantId: input.tenant.id,
          role: input.role,
        });
        return { tenant, user: this.store.getUser(user.id)!, membership };
      }),
    };
  }

  readonly commands: ControlPlane["commands"] = {
    setTenantStatus: async (input) => this.store.transaction(() => {
      if (!this.store.setTenantStatus(input.tenantId, input.status)) return null;
      this.store.recordPlatformAudit({
        actorUserId: input.actorUserId,
        action: "set_tenant_status",
        targetTenantId: input.tenantId,
        targetResource: `tenant:${input.tenantId}`,
        detail: { status: input.status },
      });
      return this.store.getTenant(input.tenantId);
    }),
    setUserStatus: async (input) => this.store.transaction(() => {
      if (!this.store.setUserStatus(input.userId, input.status)) return null;
      this.store.recordPlatformAudit({
        actorUserId: input.actorUserId,
        action: "set_user_status",
        targetResource: `user:${input.userId}`,
        detail: { status: input.status },
      });
      return this.store.getUser(input.userId);
    }),
    setUserPlatformRole: async (input) => this.store.transaction(() => {
      if (!this.store.setUserPlatformRole(input.userId, input.platformRole)) return null;
      this.store.recordPlatformAudit({
        actorUserId: input.actorUserId,
        action: "set_user_platform_role",
        targetResource: `user:${input.userId}`,
        detail: { platformRole: input.platformRole },
      });
      return this.store.getUser(input.userId);
    }),
  };

  readonly settings: ControlPlane["settings"] = {
    get: async (key) => this.store.getSetting(key),
    getAll: async () => this.store.getAllSettings(),
    set: async (key, value) => this.store.setSetting(key, value),
    setMany: async (settings) => this.store.transaction(() => {
      for (const [key, value] of Object.entries(settings)) this.store.setSetting(key, value);
    }),
  };

  readonly sessions: ControlPlane["sessions"] = {
    record: async (input) => this.store.recordSession(input),
    isRevoked: async (tenantId, jti) => this.store.isSessionRevoked(tenantId, jti),
    revoke: async (jti) => this.store.revokeSession(jti),
    pruneExpired: async (now) => this.store.pruneExpiredSessions(now),
  };

  readonly audit: ControlPlane["audit"] = {
    record: async (input) => this.store.recordPlatformAudit(input),
  };

  readonly health: ControlPlane["health"] = {
    checkReadiness: async () => {
      try {
        const probe = this.store.db.prepare("SELECT 1 AS ready").get() as { ready?: number } | undefined;
        const version = this.store.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
        const currentSchemaVersion = Number(version?.user_version ?? 0);
        return {
          ready: probe?.ready === 1 && currentSchemaVersion === CONTROL_LATEST_SCHEMA_VERSION,
          currentSchemaVersion,
          latestSchemaVersion: CONTROL_LATEST_SCHEMA_VERSION,
        };
      } catch {
        return { ready: false, currentSchemaVersion: 0, latestSchemaVersion: CONTROL_LATEST_SCHEMA_VERSION };
      }
    },
  };

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsStore) this.store.close();
  }

  private findFirstActiveForLogin(userId: Parameters<MembershipDirectory["findFirstActiveForLogin"]>[0], allowPlatformFallback: boolean) {
    const membership = this.store.db.prepare(`
      SELECT memberships.tenant_id, memberships.role
      FROM memberships
      JOIN tenants ON tenants.id=memberships.tenant_id
      WHERE memberships.user_id=? AND tenants.status='active'
      ORDER BY memberships.tenant_id LIMIT 1
    `).get(userId) as { tenant_id: string; role: string } | undefined;
    if (membership) {
      return { tenantId: createTenantId(membership.tenant_id), role: TenantRoleSchema.parse(membership.role) };
    }
    if (!allowPlatformFallback) return null;
    const fallback = this.store.db.prepare("SELECT id FROM tenants WHERE status='active' ORDER BY id LIMIT 1").get() as { id: string } | undefined;
    return fallback ? { tenantId: createTenantId(fallback.id), role: "member" as const } : null;
  }

  private install(input: Parameters<ControlPlaneProvisioning["install"]>[0]): ReturnType<ControlPlaneProvisioning["install"]> {
    return Promise.resolve(this.store.transaction(() => {
      if (this.store.getSetting("installed") === "true") {
        throw new HttpError(409, "already_installed", "系统已完成安装");
      }
      const tenant = this.store.getTenant(input.tenant.id) ?? this.store.createTenant(input.tenant);
      let admin: ControlUser | undefined;
      let membership;
      if (input.admin) {
        admin = this.store.createUser({
          id: input.admin.id,
          displayName: input.admin.displayName,
          username: input.admin.username,
          password_hash: input.admin.passwordHash,
          platform_role: "admin",
        });
        membership = this.store.upsertMembership({ userId: admin.id, tenantId: tenant.id, role: "owner" });
      }
      for (const [key, value] of Object.entries(input.settings)) this.store.setSetting(key, value);
      this.store.setSetting("installed", "true");
      return {
        tenant,
        ...(admin ? { admin } : {}),
        ...(membership ? { membership } : {}),
      };
    }));
  }

  private createTenantWithOwner(input: Parameters<ControlPlaneProvisioning["createTenantWithOwner"]>[0]): ReturnType<ControlPlaneProvisioning["createTenantWithOwner"]> {
    return Promise.resolve(this.store.transaction(() => {
      const tenant = this.store.createTenant(input.tenant);
      const membership = this.store.upsertMembership({ userId: input.ownerUserId, tenantId: tenant.id, role: "owner" });
      return { tenant, membership };
    }));
  }

  private inviteOrAttachMember(input: Parameters<ControlPlaneProvisioning["inviteOrAttachMember"]>[0]): ReturnType<ControlPlaneProvisioning["inviteOrAttachMember"]> {
    return Promise.resolve(this.store.transaction(() => {
      const existing = this.store.getUserByUsername(input.username);
      const user: ControlUser = existing ?? this.store.createUser({
        id: input.userId,
        displayName: input.displayName,
        username: input.username,
        password_hash: input.passwordHash,
      });
      const membership = this.store.upsertMembership({ userId: user.id, tenantId: input.tenantId, role: input.role });
      return { user, membership, created: existing === null };
    }));
  }
}

export function createSqliteControlPlaneAdapter(systemRoot: string): SqliteControlPlaneAdapter {
  return new SqliteControlPlaneAdapter(createControlStore(systemRoot), { closeStore: true });
}
