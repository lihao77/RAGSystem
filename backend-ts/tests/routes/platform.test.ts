import { afterEach, describe, expect, it } from "vitest";

import { createTenantId, createUserId } from "../../src/identity/types.js";
import { createSessionTokenService } from "../../src/services/runtime/session-token-service.js";
import { hashPassword } from "../../src/utils/password-hash.js";
import { buildTestHarness } from "../helpers/app.js";

const secret = "platform-route-secret-0123456789abcdef0123456789";
const close = new Array<() => Promise<void>>();

afterEach(async () => {
  for (const callback of close.splice(0)) await callback();
});

describe("平台控制面", () => {
  it("平台 admin 可列租户、封禁用户，disabled 用户旧 token 立即 401", async () => {
    const harness = await installedHarness();
    const adminToken = await login(harness, "admin", "password123");
    const tenantId = createTenantId("tnt_customer");
    const userId = createUserId("usr_customer_owner");
    harness.controlStore.createTenant({ id: tenantId, displayName: "Customer" });
    harness.controlStore.createUser({ id: userId, displayName: "Customer Owner", username: "customer", password_hash: hashPassword("password123") });
    harness.controlStore.upsertMembership({ userId, tenantId, role: "owner" });
    const userToken = await login(harness, "customer", "password123");

    const tenants = await harness.app.inject({ method: "GET", url: "/api/platform/tenants", headers: bearer(adminToken) });
    expect(tenants.statusCode).toBe(200);
    expect(tenants.json().tenants).toEqual(expect.arrayContaining([expect.objectContaining({ id: tenantId })]));

    const disabled = await harness.app.inject({
      method: "PATCH",
      url: `/api/platform/users/${userId}/status`,
      headers: bearer(adminToken),
      payload: { status: "disabled" },
    });
    expect(disabled.statusCode).toBe(200);

    const oldTokenRequest = await harness.app.inject({ method: "GET", url: "/api/health", headers: bearer(userToken) });
    expect(oldTokenRequest.statusCode).toBe(401);
  });

  it("暂停租户后成员旧 token 立即 401，但平台 admin 仍可恢复", async () => {
    const harness = await installedHarness();
    const adminToken = await login(harness, "admin", "password123");
    const suspended = await harness.app.inject({
      method: "PATCH",
      url: "/api/platform/tenants/tnt_default/status",
      headers: bearer(adminToken),
      payload: { status: "suspended" },
    });
    expect(suspended.statusCode).toBe(200);

    const tenantRequest = await harness.app.inject({ method: "GET", url: "/api/health", headers: bearer(adminToken) });
    expect(tenantRequest.statusCode).toBe(401);
    const platformMe = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers: bearer(adminToken) });
    expect(platformMe.statusCode).toBe(200);
    expect(platformMe.json()).toEqual(expect.objectContaining({ platformRole: "admin" }));
    const restored = await harness.app.inject({
      method: "PATCH",
      url: "/api/platform/tenants/tnt_default/status",
      headers: bearer(adminToken),
      payload: { status: "active" },
    });
    expect(restored.statusCode).toBe(200);
  });

  it("平台 admin 无目标租户 membership 仍可只读穿透会话", async () => {
    const harness = await installedHarness();
    const adminToken = await login(harness, "admin", "password123");
    const tenantId = createTenantId("tnt_support_target");
    harness.controlStore.createTenant({ id: tenantId, displayName: "Support Target" });
    harness.container.sessionApplication.createSession({ tenantId, userId: createUserId("usr_external"), sessionId: "support-session" });

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/platform/tenants/${tenantId}/sessions`,
      headers: bearer(adminToken),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual(expect.arrayContaining([expect.objectContaining({ session_id: "support-session" })]));
    expect(harness.controlStore.getMembership(harness.controlStore.getUserByUsername("admin")!.id, tenantId)).toBeNull();
  });

  it("普通 owner 与伪造 platform_role claim 都无法通过实时查库守卫", async () => {
    const harness = await installedHarness();
    const tenantId = createTenantId("tnt_regular");
    const userId = createUserId("usr_regular_owner");
    harness.controlStore.createTenant({ id: tenantId, displayName: "Regular" });
    harness.controlStore.createUser({ id: userId, displayName: "Regular Owner", username: "regular", password_hash: hashPassword("password123") });
    harness.controlStore.upsertMembership({ userId, tenantId, role: "owner" });
    const ownerToken = await login(harness, "regular", "password123");
    const ownerResponse = await harness.app.inject({ method: "GET", url: "/api/platform/users", headers: bearer(ownerToken) });
    expect(ownerResponse.statusCode).toBe(403);

    const tokenService = createSessionTokenService(secret, {
      isSessionRevoked: (claimTenantId, jti) => harness.controlStore.isSessionRevoked(claimTenantId, jti),
      revokeSession: (jti) => harness.controlStore.revokeSession(jti),
    });
    const forged = tokenService.issueToken({ userId, tenantId, role: "owner", platformRole: "admin" });
    harness.controlStore.recordSession({ jti: forged.claims.jti, userId, tenantId, issuedAt: forged.claims.iat, expiresAt: forged.claims.exp });
    const forgedResponse = await harness.app.inject({ method: "GET", url: "/api/platform/users", headers: bearer(forged.token) });
    expect(forgedResponse.statusCode).toBe(403);
  });
});

async function installedHarness() {
  const harness = await buildTestHarness({ sessionJwtSecret: secret });
  const installed = await harness.app.inject({
    method: "POST",
    url: "/api/install",
    payload: { deployment: "saas", tenancy: "multi", admin: { username: "admin", password: "password123" } },
  });
  expect(installed.statusCode).toBe(200);
  close.push(() => harness.app.close());
  return harness;
}

async function login(harness: Awaited<ReturnType<typeof buildTestHarness>>, username: string, password: string): Promise<string> {
  const response = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { username, password } });
  expect(response.statusCode).toBe(200);
  return response.json().token as string;
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}
