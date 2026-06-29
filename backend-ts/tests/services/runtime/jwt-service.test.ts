import { describe, expect, it } from "vitest";

import { createWidgetAuthService, WidgetAuthError } from "../../../src/services/runtime/jwt-service.js";
import { createWidgetCredentialStore } from "../../../src/services/stores/widget-credential-store/index.js";

const SECRET = "unit-test-secret-0123456789abcdef0123456789";

function makeService(secret: string = SECRET) {
  const store = createWidgetCredentialStore({ dbPath: ":memory:" });
  const service = createWidgetAuthService(secret, store.ops);
  return { service, store };
}

describe("WidgetAuthService (jwt-service)", () => {
  it("round-trips: issued token verifies and carries app_key as sub", () => {
    const { service, store } = makeService();
    const app = store.ops.createApp({ display_name: "x" });
    const { token } = service.issueToken(app.app_key);
    const claims = service.verifyWsToken(token);
    expect(claims.sub).toBe(app.app_key);
    expect(claims.scope).toBe("widget");
    store.close();
  });

  it("verifyAppCredentials accepts correct secret, rejects wrong / unknown app", () => {
    const { service, store } = makeService();
    const app = store.ops.createApp({ display_name: "x" });
    expect(service.verifyAppCredentials(app.app_key, app.secret)?.app_key).toBe(app.app_key);
    expect(service.verifyAppCredentials(app.app_key, "wrong")).toBeNull();
    expect(service.verifyAppCredentials("unknown_app", app.secret)).toBeNull();
    store.close();
  });

  it("rejects tampered signature", () => {
    const { service, store } = makeService();
    const app = store.ops.createApp({ display_name: "x" });
    const { token } = service.issueToken(app.app_key);
    const tampered = `${token.slice(0, -4)}aaaa`;
    expect(() => service.verifyWsToken(tampered)).toThrow(WidgetAuthError);
    store.close();
  });

  it("rejects missing token", () => {
    const { service, store } = makeService();
    expect(() => service.verifyWsToken(undefined)).toThrow(WidgetAuthError);
    store.close();
  });

  it("rejects token signed by a different secret", () => {
    const store = createWidgetCredentialStore({ dbPath: ":memory:" });
    const app = store.ops.createApp({ display_name: "x" });
    const serviceA = createWidgetAuthService(SECRET, store.ops);
    const { token } = serviceA.issueToken(app.app_key);
    const serviceB = createWidgetAuthService("another-secret-0123456789abcdef0123456789", store.ops);
    expect(() => serviceB.verifyWsToken(token)).toThrow(WidgetAuthError);
    store.close();
  });

  it("refuses to construct with a secret shorter than 32 chars", () => {
    const store = createWidgetCredentialStore({ dbPath: ":memory:" });
    expect(() => createWidgetAuthService("short", store.ops)).toThrow();
    store.close();
  });
});
