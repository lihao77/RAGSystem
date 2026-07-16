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

  it("issues a session-bound WS ticket only for the matching Origin and app", async () => {
    const harness = await buildTestHarness({ widgetJwtSecret: secret }); close.push(() => harness.app.close());
    const widgetApp = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "public", allowed_origins: ["https://host.test"] });
    const headers = { "x-widget-key": widgetApp.app_key, origin: "https://host.test" };
    const session = await harness.app.inject({ method: "POST", url: "/api/widget/sessions", headers, payload: {} });
    const sessionId = session.json().data.session_id as string;

    const issued = await harness.app.inject({ method: "POST", url: `/api/widget/sessions/${sessionId}/ws-ticket`, headers });
    expect(issued.statusCode).toBe(200);
    expect(issued.json().data.ticket).toEqual(expect.any(String));
    expect((await harness.app.inject({
      method: "POST",
      url: `/api/widget/sessions/${sessionId}/ws-ticket`,
      headers: { ...headers, origin: "https://wrong.test" },
    })).statusCode).toBe(401);

    const otherApp = harness.widgetCredentialStore.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "other", allowed_origins: ["https://host.test"] });
    expect((await harness.app.inject({
      method: "POST",
      url: `/api/widget/sessions/${sessionId}/ws-ticket`,
      headers: { "x-widget-key": otherApp.app_key, origin: "https://host.test" },
    })).statusCode).toBe(404);
  });
});
