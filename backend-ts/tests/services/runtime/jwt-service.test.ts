import { describe, expect, it } from "vitest";

import { createTenantId } from "../../../src/identity/types.js";
import { createWidgetAuthService, WidgetAuthError } from "../../../src/services/runtime/jwt-service.js";
import { createControlStore } from "../../../src/services/stores/control-store/index.js";
import { createWidgetCredentialStore } from "../../../src/services/stores/widget-credential-store/index.js";
import { makeTempRoot } from "../../helpers/temp-db.js";

const SECRET = "unit-test-secret-0123456789abcdef0123456789";
const tenantId = createTenantId("tnt_widget_auth");

function makeService(secret: string = SECRET) {
  const controlStore = createControlStore(makeTempRoot());
  controlStore.createTenant({ id: tenantId, displayName: "Widget" });
  const store = createWidgetCredentialStore(controlStore.db);
  const service = createWidgetAuthService(secret, store.ops);
  return { service, store, controlStore };
}

describe("WidgetAuthService", () => {
  it("token 校验返回 app_key 与 tenant_id", () => {
    const { service, store, controlStore } = makeService();
    const app = store.ops.createApp({ tenantId, display_name: "x" });
    const { token } = service.issueToken(store.ops.getApp(tenantId, app.app_key)!);
    const claims = service.verifyWsToken(token);
    expect(claims).toMatchObject({ sub: app.app_key, tenant_id: tenantId, scope: "widget" });
    store.close();
    controlStore.close();
  });

  it("校验正确凭证并拒绝错误凭证", () => {
    const { service, store, controlStore } = makeService();
    const app = store.ops.createApp({ tenantId, display_name: "x" });
    expect(service.verifyAppCredentials(app.app_key, app.secret)?.tenant_id).toBe(tenantId);
    expect(service.verifyAppCredentials(app.app_key, "wrong")).toBeNull();
    expect(service.verifyAppCredentials("unknown_app", app.secret)).toBeNull();
    store.close();
    controlStore.close();
  });

  it("拒绝篡改签名、缺失 token 与不同密钥", () => {
    const { service, store, controlStore } = makeService();
    const app = store.ops.createApp({ tenantId, display_name: "x" });
    const { token } = service.issueToken(store.ops.getApp(tenantId, app.app_key)!);
    expect(() => service.verifyWsToken(`${token.slice(0, -4)}aaaa`)).toThrow(WidgetAuthError);
    expect(() => service.verifyWsToken(undefined)).toThrow(WidgetAuthError);
    const other = createWidgetAuthService("another-secret-0123456789abcdef0123456789", store.ops);
    expect(() => other.verifyWsToken(token)).toThrow(WidgetAuthError);
    store.close();
    controlStore.close();
  });

  it("拒绝过短密钥", () => {
    const { store, controlStore } = makeService();
    expect(() => createWidgetAuthService("short", store.ops)).toThrow();
    store.close();
    controlStore.close();
  });
});
