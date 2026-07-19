import { describe, expect, it } from "vitest";

import { createSqliteControlPlaneAdapter } from "../../src/adapters/local/sqlite/sqlite-control-plane-adapter.js";
import { createTenantId, createUserId } from "../../src/identity/types.js";
import { CONTROL_LATEST_SCHEMA_VERSION } from "../../src/adapters/local/sqlite/control-store/index.js";
import { runControlPlaneContract } from "../contracts/control-plane-contract.js";
import { makeTempRoot } from "../helpers/temp-db.js";

runControlPlaneContract("SQLite", async () => {
  const systemRoot = makeTempRoot();
  return {
    controlPlane: createSqliteControlPlaneAdapter(systemRoot),
    reopen: async () => createSqliteControlPlaneAdapter(systemRoot),
  };
});

describe("SqliteControlPlaneAdapter", () => {
  it("implements the tenant, user, membership, settings and session contracts", async () => {
    const control = createSqliteControlPlaneAdapter(makeTempRoot());
    const tenantId = createTenantId("tnt_contract");
    const userId = createUserId("usr_contract");
    try {
      await control.tenants.create({ id: tenantId, displayName: "Contract" });
      await control.users.create({
        id: userId,
        displayName: "Contract User",
        username: "contract-user",
        passwordHash: "hashed",
        platformRole: "admin",
      });
      await control.memberships.upsert({ userId, tenantId, role: "owner" });

      expect(await control.tenants.get(tenantId)).toMatchObject({ displayName: "Contract", status: "active" });
      expect(await control.users.findCredentialsByUsername("contract-user")).toMatchObject({ id: userId, passwordHash: "hashed" });
      expect(await control.memberships.listByTenant(tenantId)).toEqual([{ userId, tenantId, role: "owner", type: "human" }]);

      await control.settings.setMany({ installed: "true", auth_mode: "password" });
      expect(await control.settings.getAll()).toEqual({ auth_mode: "password", installed: "true" });

      expect(await control.sessions.isRevoked(tenantId, "missing")).toBe(true);
      await control.sessions.record({ jti: "session-1", userId, tenantId, issuedAt: 10, expiresAt: 20 });
      expect(await control.sessions.isRevoked(tenantId, "session-1")).toBe(false);
      expect(await control.sessions.revoke("session-1")).toBe(true);
      expect(await control.sessions.isRevoked(tenantId, "session-1")).toBe(true);

      expect(await control.health.checkReadiness()).toEqual({
        ready: true,
        currentSchemaVersion: CONTROL_LATEST_SCHEMA_VERSION,
        latestSchemaVersion: CONTROL_LATEST_SCHEMA_VERSION,
      });
      control.store.db.exec(`PRAGMA user_version = ${CONTROL_LATEST_SCHEMA_VERSION - 1}`);
      expect(await control.health.checkReadiness()).toEqual({
        ready: false,
        currentSchemaVersion: CONTROL_LATEST_SCHEMA_VERSION - 1,
        latestSchemaVersion: CONTROL_LATEST_SCHEMA_VERSION,
      });
    } finally {
      await control.close();
    }
  });

  it("installs tenant, admin, owner membership and settings atomically", async () => {
    const control = createSqliteControlPlaneAdapter(makeTempRoot());
    const tenantId = createTenantId("tnt_install");
    const adminId = createUserId("usr_install_admin");
    try {
      const result = await control.provisioning.install({
        tenant: { id: tenantId, displayName: "Installed" },
        admin: { id: adminId, displayName: "Admin", username: "admin", passwordHash: "hashed" },
        settings: { installed: "true", deployment_mode: "saas" },
      });

      expect(result).toMatchObject({ tenant: { id: tenantId }, admin: { id: adminId }, membership: { role: "owner" } });
      expect(await control.settings.get("installed")).toBe("true");
      await expect(control.provisioning.install({
        tenant: { id: createTenantId("tnt_second"), displayName: "Second" },
        settings: { installed: "true" },
      })).rejects.toMatchObject({ statusCode: 409, code: "already_installed" });
      expect(await control.tenants.get(createTenantId("tnt_second"))).toBeNull();
    } finally {
      await control.close();
    }
  });

  it("rolls back provisioning when a compound write fails", async () => {
    const control = createSqliteControlPlaneAdapter(makeTempRoot());
    const existingTenantId = createTenantId("tnt_existing");
    try {
      await control.tenants.create({ id: existingTenantId, displayName: "Existing" });
      await control.users.create({ id: createUserId("usr_existing"), displayName: "Existing", username: "duplicate" });
      const failedTenantId = createTenantId("tnt_rolled_back");

      await expect(control.provisioning.install({
        tenant: { id: failedTenantId, displayName: "Rolled back" },
        admin: {
          id: createUserId("usr_new_admin"),
          displayName: "Duplicate",
          username: "duplicate",
          passwordHash: "hashed",
        },
        settings: { installed: "true" },
      })).rejects.toThrow();

      expect(await control.tenants.get(failedTenantId)).toBeNull();
      expect(await control.settings.get("installed")).toBeNull();
    } finally {
      await control.close();
    }
  });

  it("creates and removes members atomically while preserving the unique owner", async () => {
    const control = createSqliteControlPlaneAdapter(makeTempRoot());
    const ownerId = createUserId("usr_owner_contract");
    const secondOwnerId = createUserId("usr_second_owner");
    const tenantId = createTenantId("tnt_membership_contract");
    try {
      await control.users.create({ id: ownerId, displayName: "Owner" });
      await control.provisioning.createTenantWithOwner({ tenant: { id: tenantId, displayName: "Members" }, ownerUserId: ownerId });
      await expect(control.provisioning.removeMember({ tenantId, userId: ownerId })).rejects.toMatchObject({ statusCode: 403 });

      const invited = await control.provisioning.inviteOrAttachMember({
        tenantId,
        userId: secondOwnerId,
        username: "second-owner",
        passwordHash: "hashed",
        displayName: "Second Owner",
        role: "owner",
      });
      expect(invited.created).toBe(true);
      expect(await control.provisioning.removeMember({ tenantId, userId: ownerId })).toBe(true);
      expect(await control.memberships.get(ownerId, tenantId)).toBeNull();
    } finally {
      await control.close();
    }
  });

  it("selects the first active membership and supports platform fallback", async () => {
    const control = createSqliteControlPlaneAdapter(makeTempRoot());
    const memberId = createUserId("usr_login_member");
    const platformId = createUserId("usr_login_platform");
    const activeId = createTenantId("tnt_a_active");
    const suspendedId = createTenantId("tnt_b_suspended");
    try {
      await control.tenants.create({ id: suspendedId, displayName: "Suspended", status: "suspended" });
      await control.tenants.create({ id: activeId, displayName: "Active" });
      await control.users.create({ id: memberId, displayName: "Member" });
      await control.users.create({ id: platformId, displayName: "Platform", platformRole: "admin" });
      await control.memberships.upsert({ userId: memberId, tenantId: suspendedId, role: "owner" });
      await control.memberships.upsert({ userId: memberId, tenantId: activeId, role: "admin" });

      expect(await control.memberships.findFirstActiveForLogin(memberId, false)).toEqual({ tenantId: activeId, role: "admin" });
      expect(await control.memberships.findFirstActiveForLogin(platformId, false)).toBeNull();
      expect(await control.memberships.findFirstActiveForLogin(platformId, true)).toEqual({ tenantId: activeId, role: "member" });
    } finally {
      await control.close();
    }
  });

  it("keeps state changes and platform audit in one transaction", async () => {
    const control = createSqliteControlPlaneAdapter(makeTempRoot());
    const tenantId = createTenantId("tnt_audited");
    try {
      await control.tenants.create({ id: tenantId, displayName: "Audited" });
      await expect(control.commands.setTenantStatus({
        actorUserId: createUserId("usr_missing_actor"),
        tenantId,
        status: "suspended",
      })).rejects.toThrow();
      expect(await control.tenants.get(tenantId)).toMatchObject({ status: "active" });
    } finally {
      await control.close();
    }
  });

  it("initializes the Local identity atomically and idempotently", async () => {
    const control = createSqliteControlPlaneAdapter(makeTempRoot());
    const tenantId = createTenantId("tnt_local_contract");
    const userId = createUserId("usr_local_contract");
    try {
      const input = {
        tenant: { id: tenantId, displayName: "Local" },
        user: { id: userId, displayName: "Local User", platformRole: "admin" as const },
        role: "owner" as const,
      };
      await control.provisioning.ensureLocalIdentity(input);
      await control.provisioning.ensureLocalIdentity(input);
      expect(await control.memberships.get(userId, tenantId)).toMatchObject({ role: "owner" });
      expect(await control.users.get(userId)).toMatchObject({ status: "active", platformRole: "admin" });
    } finally {
      await control.close();
      await control.close();
    }
  });
});
