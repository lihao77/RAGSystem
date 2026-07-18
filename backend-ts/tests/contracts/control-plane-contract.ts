import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ControlPlane } from "../../src/contracts/control-plane/index.js";
import { createTenantId, createUserId } from "../../src/identity/types.js";

export interface ControlPlaneContractHarness {
  controlPlane: ControlPlane;
  reopen(): Promise<ControlPlane>;
}

export type ControlPlaneContractFactory = () => Promise<ControlPlaneContractHarness>;

export function runControlPlaneContract(name: string, createHarness: ControlPlaneContractFactory): void {
  describe(`${name} ControlPlane contract`, () => {
    it("persists install, credentials, membership, settings and sessions across reopen", async () => {
      const harness = await createHarness();
      const suffix = idSuffix();
      const tenantId = createTenantId(`tnt_contract_${suffix}`);
      const userId = createUserId(`usr_contract_${suffix}`);
      let control = harness.controlPlane;
      try {
        const installed = await control.provisioning.install({
          tenant: { id: tenantId, displayName: "Contract Tenant" },
          admin: {
            id: userId,
            displayName: "Contract Admin",
            username: `admin-${suffix}`,
            passwordHash: "contract-password-hash",
          },
          settings: { deployment_mode: "saas", auth_mode: "password" },
        });
        expect(installed).toMatchObject({
          tenant: { id: tenantId, status: "active" },
          admin: { id: userId, platformRole: "admin", status: "active" },
          membership: { userId, tenantId, role: "owner" },
        });
        expect(await control.users.get(userId)).not.toHaveProperty("passwordHash");
        expect(await control.users.findCredentialsByUsername(`admin-${suffix}`))
          .toMatchObject({ id: userId, passwordHash: "contract-password-hash" });
        expect(await control.memberships.findFirstActiveForLogin(userId, false))
          .toEqual({ tenantId, role: "owner" });

        await control.sessions.record({
          jti: `jti-${suffix}`,
          userId,
          tenantId,
          issuedAt: 10,
          expiresAt: 100,
        });
        expect(await control.sessions.isRevoked(tenantId, `jti-${suffix}`)).toBe(false);
        expect(await control.sessions.isRevoked(createTenantId(`tnt_other_${suffix}`), `jti-${suffix}`)).toBe(true);

        await control.close();
        control = await harness.reopen();
        expect(await control.settings.get("deployment_mode")).toBe("saas");
        expect(await control.tenants.get(tenantId)).toMatchObject({ displayName: "Contract Tenant" });
        expect(await control.sessions.isRevoked(tenantId, `jti-${suffix}`)).toBe(false);
        expect(await control.sessions.revoke(`jti-${suffix}`)).toBe(true);
        expect(await control.sessions.isRevoked(tenantId, `jti-${suffix}`)).toBe(true);
      } finally {
        await control.close();
      }
    });

    it("rolls back failed provisioning and rejects a second install", async () => {
      const { controlPlane: control } = await createHarness();
      const suffix = idSuffix();
      const existingTenantId = createTenantId(`tnt_existing_${suffix}`);
      const failedTenantId = createTenantId(`tnt_failed_${suffix}`);
      try {
        await control.tenants.create({ id: existingTenantId, displayName: "Existing" });
        await control.users.create({
          id: createUserId(`usr_existing_${suffix}`),
          displayName: "Existing",
          username: `duplicate-${suffix}`,
        });
        await expect(control.provisioning.install({
          tenant: { id: failedTenantId, displayName: "Rolled back" },
          admin: {
            id: createUserId(`usr_failed_${suffix}`),
            displayName: "Duplicate",
            username: `duplicate-${suffix}`,
            passwordHash: "hash",
          },
          settings: { installed: "true" },
        })).rejects.toThrow();
        expect(await control.tenants.get(failedTenantId)).toBeNull();
        expect(await control.settings.get("installed")).toBeNull();

        await control.provisioning.install({
          tenant: { id: createTenantId(`tnt_installed_${suffix}`), displayName: "Installed" },
          settings: { deployment_mode: "local" },
        });
        await expect(control.provisioning.install({
          tenant: { id: createTenantId(`tnt_second_${suffix}`), displayName: "Second" },
          settings: {},
        })).rejects.toMatchObject({ code: "already_installed" });
        expect(await control.tenants.get(createTenantId(`tnt_second_${suffix}`))).toBeNull();
      } finally {
        await control.close();
      }
    });

    it("excludes suspended tenants from login selection", async () => {
      const { controlPlane: control } = await createHarness();
      const suffix = idSuffix();
      const tenantId = createTenantId(`tnt_suspend_${suffix}`);
      const userId = createUserId(`usr_suspend_${suffix}`);
      try {
        await control.tenants.create({ id: tenantId, displayName: "Suspend" });
        await control.users.create({ id: userId, displayName: "Member" });
        await control.memberships.upsert({ userId, tenantId, role: "member" });
        expect(await control.memberships.findFirstActiveForLogin(userId, false)).toEqual({ tenantId, role: "member" });
        expect(await control.tenants.setStatus(tenantId, "suspended")).toBe(true);
        expect(await control.memberships.findFirstActiveForLogin(userId, false)).toBeNull();
      } finally {
        await control.close();
      }
    });

    it("allows only one concurrent removal of the final two owners", async () => {
      const { controlPlane: control } = await createHarness();
      const suffix = idSuffix();
      const tenantId = createTenantId(`tnt_owners_${suffix}`);
      const firstOwnerId = createUserId(`usr_owner_a_${suffix}`);
      const secondOwnerId = createUserId(`usr_owner_b_${suffix}`);
      try {
        await control.users.create({ id: firstOwnerId, displayName: "Owner A" });
        await control.users.create({ id: secondOwnerId, displayName: "Owner B" });
        await control.provisioning.createTenantWithOwner({
          tenant: { id: tenantId, displayName: "Owners" },
          ownerUserId: firstOwnerId,
        });
        await control.memberships.upsert({ userId: secondOwnerId, tenantId, role: "owner" });

        const results = await Promise.allSettled([
          control.memberships.delete(firstOwnerId, tenantId),
          control.memberships.delete(secondOwnerId, tenantId),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect((await control.memberships.listByTenant(tenantId)).filter((membership) => membership.role === "owner"))
          .toHaveLength(1);
      } finally {
        await control.close();
      }
    });

    it("allows only one concurrent disable of the final two platform admins", async () => {
      const { controlPlane: control } = await createHarness();
      const suffix = idSuffix();
      const firstAdminId = createUserId(`usr_admin_a_${suffix}`);
      const secondAdminId = createUserId(`usr_admin_b_${suffix}`);
      try {
        await control.users.create({ id: firstAdminId, displayName: "Admin A", platformRole: "admin" });
        await control.users.create({ id: secondAdminId, displayName: "Admin B", platformRole: "admin" });
        const results = await Promise.allSettled([
          control.users.setStatus(firstAdminId, "disabled"),
          control.users.setStatus(secondAdminId, "disabled"),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        const users = await Promise.all([control.users.get(firstAdminId), control.users.get(secondAdminId)]);
        expect(users.filter((user) => user?.platformRole === "admin" && user.status === "active")).toHaveLength(1);
      } finally {
        await control.close();
      }
    });
  });
}

function idSuffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}
