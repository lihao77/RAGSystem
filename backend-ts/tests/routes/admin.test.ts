import { afterEach, describe, expect, it, vi } from "vitest";

import { createTenantId, createUserId } from "../../src/identity/types.js";
import { buildTestHarness } from "../helpers/app.js";

const secret = "admin-routes-test-secret-at-least-32-characters";
const close: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(close.splice(0).map((dispose) => dispose()));
});

describe("多租户管理 API", () => {
  it("owner 完成租户与成员生命周期并切换租户", async () => {
    const harness = await installedHarness();
    const ownerLogin = await login(harness.app, "admin", "password123");
    const ownerBody = ownerLogin.json();
    const ownerToken = ownerBody.token as string;
    const ownerId = ownerBody.user.id as string;
    const acquire = vi.spyOn(harness.registry, "acquire");

    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tenants",
      headers: bearer(ownerToken),
      payload: { displayName: "Acme" },
    });
    expect(created.statusCode).toBe(200);
    const tenantId = created.json().tenant.id as string;
    expect(tenantId).toMatch(/^tnt_[a-z0-9]+$/);
    expect(created.json().tenant.role).toBe("owner");

    const tenants = await harness.app.inject({
      method: "GET",
      url: "/api/admin/tenants",
      headers: bearer(ownerToken),
    });
    expect(tenants.statusCode).toBe(200);
    expect(tenants.json().tenants).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: tenantId, displayName: "Acme", role: "owner" }),
    ]));

    const invited = await harness.app.inject({
      method: "POST",
      url: `/api/admin/tenants/${tenantId}/members`,
      headers: bearer(ownerToken),
      payload: { username: "alice", password: "password456", displayName: "Alice" },
    });
    expect(invited.statusCode).toBe(200);
    const aliceId = invited.json().member.user.id as string;
    expect(invited.json().member).toEqual(expect.objectContaining({ tenantId, role: "member" }));

    const members = await harness.app.inject({
      method: "GET",
      url: `/api/admin/tenants/${tenantId}/members`,
      headers: bearer(ownerToken),
    });
    expect(members.statusCode).toBe(200);
    expect(members.json().members).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: aliceId, tenantId, role: "member", user: expect.objectContaining({ username: "alice" }) }),
    ]));

    const aliceLogin = await login(harness.app, "alice", "password456");
    const aliceInitialToken = aliceLogin.json().token as string;
    const aliceMemberSwitch = await switchTenant(harness.app, aliceInitialToken, tenantId);
    expect(aliceMemberSwitch.statusCode).toBe(200);
    const aliceMemberToken = aliceMemberSwitch.json().token as string;

    const memberReadOnly = await harness.app.inject({
      method: "GET",
      url: `/api/admin/tenants/${tenantId}/members`,
      headers: bearer(aliceMemberToken),
    });
    expect(memberReadOnly.statusCode).toBe(200);
    expect(memberReadOnly.json().members.length).toBeGreaterThanOrEqual(1);
    const createDenied = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tenants",
      headers: bearer(aliceMemberToken),
      payload: { displayName: "Denied" },
    });
    expect(createDenied.statusCode).toBe(403);

    const promoted = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/tenants/${tenantId}/members/${aliceId}`,
      headers: bearer(ownerToken),
      payload: { role: "admin" },
    });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().member.role).toBe("admin");

    const userCount = harness.controlStore.listUsers().length;
    const existingInvited = await harness.app.inject({
      method: "POST",
      url: "/api/admin/tenants/tnt_default/members",
      headers: bearer(ownerToken),
      payload: { username: "alice", password: "ignored-password", role: "member" },
    });
    expect(existingInvited.statusCode).toBe(200);
    expect(existingInvited.json().member.user.id).toBe(aliceId);
    expect(harness.controlStore.listUsers()).toHaveLength(userCount);

    const aliceAdminSwitch = await switchTenant(harness.app, aliceInitialToken, tenantId);
    expect(aliceAdminSwitch.statusCode).toBe(200);
    expect(aliceAdminSwitch.json().role).toBe("admin");
    const aliceAdminToken = aliceAdminSwitch.json().token as string;

    const adminRoleDenied = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/tenants/${tenantId}/members/${ownerId}`,
      headers: bearer(aliceAdminToken),
      payload: { role: "member" },
    });
    expect(adminRoleDenied.statusCode).toBe(403);

    const adminOwnerInviteDenied = await harness.app.inject({
      method: "POST",
      url: `/api/admin/tenants/${tenantId}/members`,
      headers: bearer(aliceAdminToken),
      payload: { username: "bob", password: "password789", role: "owner" },
    });
    expect(adminOwnerInviteDenied.statusCode).toBe(403);

    const uniqueOwnerDemotionDenied = await harness.app.inject({
      method: "PATCH",
      url: `/api/admin/tenants/${tenantId}/members/${ownerId}`,
      headers: bearer(ownerToken),
      payload: { role: "admin" },
    });
    expect(uniqueOwnerDemotionDenied.statusCode).toBe(403);

    const uniqueOwnerDenied = await harness.app.inject({
      method: "DELETE",
      url: `/api/admin/tenants/${tenantId}/members/${ownerId}`,
      headers: bearer(aliceAdminToken),
    });
    expect(uniqueOwnerDenied.statusCode).toBe(403);

    const selfRemovalDenied = await harness.app.inject({
      method: "DELETE",
      url: `/api/admin/tenants/${tenantId}/members/${ownerId}`,
      headers: bearer(ownerToken),
    });
    expect(selfRemovalDenied.statusCode).toBe(403);

    const removed = await harness.app.inject({
      method: "DELETE",
      url: `/api/admin/tenants/${tenantId}/members/${aliceId}`,
      headers: bearer(ownerToken),
    });
    expect(removed.statusCode).toBe(200);
    expect(harness.controlStore.getMembership(createUserId(aliceId), createTenantId(tenantId))).toBeNull();

    const nonMemberSwitch = await switchTenant(harness.app, aliceAdminToken, tenantId);
    expect(nonMemberSwitch.statusCode).toBe(403);

    const ownerSwitch = await switchTenant(harness.app, ownerToken, tenantId);
    expect(ownerSwitch.statusCode).toBe(200);
    expect(ownerSwitch.json()).toEqual(expect.objectContaining({
      token: expect.any(String),
      expires_at: expect.any(Number),
      tenantId,
      role: "owner",
      user: expect.objectContaining({ id: ownerId, displayName: "admin" }),
    }));
    expect(ownerSwitch.json().token).not.toBe(ownerToken);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("控制平面路由缺少 Bearer 时统一返回 401", async () => {
    const harness = await installedHarness();
    const tenants = await harness.app.inject({ method: "GET", url: "/api/admin/tenants" });
    expect(tenants.statusCode).toBe(401);
    const switched = await harness.app.inject({
      method: "POST",
      url: "/api/auth/switch-tenant",
      payload: { tenantId: "tnt_default" },
    });
    expect(switched.statusCode).toBe(401);
  });
});

async function installedHarness() {
  const harness = await buildTestHarness({ sessionJwtSecret: secret });
  close.push(() => harness.app.close());
  const installed = await harness.app.inject({
    method: "POST",
    url: "/api/install",
    payload: { deployment: "saas", tenancy: "multi", admin: { username: "admin", password: "password123" } },
  });
  expect(installed.statusCode).toBe(200);
  return harness;
}

function login(app: Awaited<ReturnType<typeof buildTestHarness>>["app"], username: string, password: string) {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
}

function switchTenant(app: Awaited<ReturnType<typeof buildTestHarness>>["app"], token: string, tenantId: string) {
  return app.inject({
    method: "POST",
    url: "/api/auth/switch-tenant",
    headers: bearer(token),
    payload: { tenantId },
  });
}

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
