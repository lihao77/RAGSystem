import { afterEach, describe, expect, it } from "vitest";

import { buildTestHarness } from "../helpers/app.js";

const secret = "session-route-secret-0123456789abcdef0123456789";
const close = new Array<() => Promise<void>>();
afterEach(async () => {
  for (const callback of close.splice(0)) await callback();
});

describe("认证路由", () => {
  it("首次安装成功，重复安装返回 409", async () => {
    const harness = await buildTestHarness();
    close.push(() => harness.app.close());
    const first = await harness.app.inject({
      method: "POST",
      url: "/api/install",
      payload: {
        deployment: "saas",
        tenancy: "multi",
        tenantDisplayName: "Acme",
        admin: { username: "admin", password: "password123" },
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual(expect.objectContaining({ deployment: "saas", auth: "password", installed: true, restart_required: true }));
    expect(harness.controlStore.getSetting("auth_mode")).toBe("password");
    expect(harness.controlStore.getTenant("tnt_default" as never)?.displayName).toBe("Acme");
    expect(harness.controlStore.getUserByUsername("admin")).not.toBeNull();

    const second = await harness.app.inject({ method: "POST", url: "/api/install", payload: { deployment: "single" } });
    expect(second.statusCode).toBe(409);
  });

  it("正确密码登录，错误密码返回 401", async () => {
    const harness = await installedPasswordHarness();
    const wrong = await harness.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "wrong" } });
    expect(wrong.statusCode).toBe(401);

    const response = await login(harness.app);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ tenantId: "tnt_default", role: "owner" }));
    expect(response.json().token).toEqual(expect.any(String));
  });

  it("me 返回身份，logout 后 token 被撤销", async () => {
    const harness = await installedPasswordHarness();
    const loginResponse = await login(harness.app);
    const token = loginResponse.json().token as string;
    const headers = { authorization: `Bearer ${token}` };

    const me = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ userId: expect.any(String), tenantId: "tnt_default", role: "owner", permissions: ["*"] });

    const logout = await harness.app.inject({ method: "POST", url: "/api/auth/logout", headers });
    expect(logout.statusCode).toBe(200);
    const revoked = await harness.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(revoked.statusCode).toBe(401);
  });

  it("过期 token 访问 me 返回 401", async () => {
    const harness = await installedPasswordHarness(0.000001);
    const loginResponse = await login(harness.app);
    const token = loginResponse.json().token as string;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("password provider 无 token 统一返回 401，local provider 保持自动身份", async () => {
    const passwordHarness = await installedPasswordHarness();
    const unauthorized = await passwordHarness.app.inject({ method: "GET", url: "/api/health" });
    expect(unauthorized.statusCode).toBe(401);

    const localHarness = await buildTestHarness({ autoIdentityProvider: true });
    close.push(() => localHarness.app.close());
    const local = await localHarness.app.inject({ method: "GET", url: "/api/health" });
    expect(local.statusCode).toBe(200);
  });
});

async function installedPasswordHarness(sessionTokenTtlHours?: number) {
  const installer = await buildTestHarness();
  const root = installer.root;
  const installed = await installer.app.inject({
    method: "POST",
    url: "/api/install",
    payload: { deployment: "saas", admin: { username: "admin", password: "password123" } },
  });
  expect(installed.statusCode).toBe(200);
  await installer.app.close();
  const harness = await buildTestHarness({
    root,
    autoIdentityProvider: true,
    sessionJwtSecret: secret,
    ...(sessionTokenTtlHours ? { sessionTokenTtlHours } : {}),
  });
  close.push(() => harness.app.close());
  return harness;
}

function login(app: Awaited<ReturnType<typeof buildTestHarness>>["app"]) {
  return app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "password123" } });
}
