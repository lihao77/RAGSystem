import { afterEach, describe, expect, it } from "vitest";
import { buildTestHarness } from "../helpers/app.js";

const secret = "widget-test-secret-widget-test-secret";
const close = new Array<() => Promise<void>>();
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });

describe("widget apps routes", () => {
  it("covers create, update, rotate, revoke and audit", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: secret }); close.push(() => harness.app.close());
    const created = await harness.app.inject({ method: "POST", url: "/api/widget/apps/", payload: { display_name: "demo", allowed_origins: ["https://host.test"] } });
    expect(created.statusCode).toBe(200); const first = created.json().app;
    const token = await harness.app.inject({ method: "POST", url: "/api/widget/auth/token", payload: { app_key: first.app_key, secret: first.secret } });
    expect(token.statusCode).toBe(200);
    expect((await harness.app.inject({ method: "PATCH", url: `/api/widget/apps/${first.app_key}`, payload: { display_name: "updated", allowed_origins: ["https://new.test"] } })).statusCode).toBe(200);
    const rotated = await harness.app.inject({ method: "POST", url: `/api/widget/apps/${first.app_key}/rotate-secret` });
    expect(rotated.statusCode).toBe(200);
    expect((await harness.app.inject({ method: "POST", url: "/api/widget/auth/token", payload: { app_key: first.app_key, secret: first.secret } })).statusCode).toBe(401);
    expect((await harness.app.inject({ method: "POST", url: `/api/widget/apps/${first.app_key}/revoke` })).statusCode).toBe(200);
    expect((await harness.app.inject({ method: "POST", url: "/api/widget/auth/token", payload: { app_key: first.app_key, secret: rotated.json().app.secret } })).statusCode).toBe(401);
    const audit = await harness.app.inject({ method: "GET", url: `/api/widget/apps/${first.app_key}/audit` });
    expect(audit.json().audit.map((entry: { action: string }) => entry.action)).toEqual(expect.arrayContaining(["create", "update", "rotate_secret", "revoke"]));
  });

  it("returns 503 when widget auth is disabled", async () => {
    const harness = await buildTestHarness(); close.push(() => harness.app.close());
    expect((await harness.app.inject({ method: "GET", url: "/api/widget/apps/" })).statusCode).toBe(503);
  });
});
