import { afterEach, describe, expect, it } from "vitest";
import { buildTestHarness } from "../helpers/app.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

const secret = "widget-test-secret-widget-test-secret";
const close = new Array<() => Promise<void>>();
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });

describe("widget publishable key", () => {
  it("requires an allowed exact Origin", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: secret }); close.push(() => harness.app.close());
    const app = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "public", allowed_origins: ["https://host.test"] });
    const request = (origin?: string) => harness.app.inject({ method: "POST", url: "/api/widget/sessions", headers: { "x-widget-key": app.app_key, ...(origin ? { origin } : {}) }, payload: {} });
    expect((await request("https://host.test")).statusCode).toBe(200);
    expect((await request("https://wrong.test")).statusCode).toBe(401);
    expect((await request()).statusCode).toBe(401);
    expect((await harness.app.inject({ method: "POST", url: "/api/widget/sessions", payload: {} })).statusCode).toBe(401);
  });

  it("rejects empty origins and revoked apps", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: secret }); close.push(() => harness.app.close());
    const empty = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "empty" });
    expect((await harness.app.inject({ method: "POST", url: "/api/widget/sessions", headers: { "x-widget-key": empty.app_key, origin: "https://host.test" }, payload: {} })).statusCode).toBe(401);
    const revoked = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "revoked", allowed_origins: ["https://host.test"] });
    harness.widgetCredentialStore.ops.revokeApp(LOCAL_TENANT_ID, revoked.app_key);
    expect((await harness.app.inject({ method: "POST", url: "/api/widget/sessions", headers: { "x-widget-key": revoked.app_key, origin: "https://host.test" }, payload: {} })).statusCode).toBe(401);
  });
});
