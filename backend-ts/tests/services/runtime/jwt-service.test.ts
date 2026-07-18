import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";

import { SqliteWidgetCredentialAdapter } from "../../../src/adapters/local/sqlite-widget-credential-adapter.js";
import { createTenantId } from "../../../src/identity/types.js";
import { createWidgetAuthService, WidgetAuthError } from "../../../src/services/runtime/jwt-service.js";
import { createControlStore } from "../../../src/services/stores/control-store/index.js";
import { createWidgetCredentialStore } from "../../../src/services/stores/widget-credential-store/index.js";
import { makeTempRoot } from "../../helpers/temp-db.js";

const SECRET = "unit-test-secret-0123456789abcdef0123456789";
const tenantId = createTenantId("tnt_widget_auth");

const bearerRequest = (token?: string): FastifyRequest => ({
  headers: token ? { authorization: `Bearer ${token}` } : {},
}) as FastifyRequest;

function makeService(secret: string = SECRET) {
  const controlStore = createControlStore(makeTempRoot());
  controlStore.createTenant({ id: tenantId, displayName: "Widget" });
  const store = createWidgetCredentialStore(controlStore.db);
  const credentials = new SqliteWidgetCredentialAdapter(store);
  const service = createWidgetAuthService(secret, credentials);
  return { service, store, credentials, controlStore };
}

describe("WidgetAuthService", () => {
  it("token 校验返回 app_key 与 tenant_id", async () => {
    const { service, store, credentials, controlStore } = makeService();
    const app = await credentials.apps.create({ tenantId, display_name: "x" });
    const { token } = await service.issueToken((await credentials.apps.get(tenantId, app.app_key))!);
    const claims = await service.requireBearer(bearerRequest(token));
    expect(claims).toMatchObject({ sub: app.app_key, tenant_id: tenantId, scope: "widget" });
    store.close();
    controlStore.close();
  });

  it("校验正确凭证并拒绝错误凭证", async () => {
    const { service, store, credentials, controlStore } = makeService();
    const app = await credentials.apps.create({ tenantId, display_name: "x" });
    await expect(service.verifyAppCredentials(app.app_key, app.secret)).resolves.toMatchObject({ tenant_id: tenantId });
    await expect(service.verifyAppCredentials(app.app_key, "wrong")).resolves.toBeNull();
    await expect(service.verifyAppCredentials("unknown_app", app.secret)).resolves.toBeNull();
    store.close();
    controlStore.close();
  });

  it("拒绝篡改签名、缺失 token 与不同密钥", async () => {
    const { service, store, credentials, controlStore } = makeService();
    const app = await credentials.apps.create({ tenantId, display_name: "x" });
    const { token } = await service.issueToken((await credentials.apps.get(tenantId, app.app_key))!);
    await expect(service.requireBearer(bearerRequest(`${token.slice(0, -4)}aaaa`))).rejects.toThrow(WidgetAuthError);
    await expect(service.requireBearer(bearerRequest())).rejects.toThrow(WidgetAuthError);
    const other = createWidgetAuthService("another-secret-0123456789abcdef0123456789", credentials);
    await expect(other.requireBearer(bearerRequest(token))).rejects.toThrow(WidgetAuthError);
    store.close();
    controlStore.close();
  });

  it("等待异步 token 撤销查询后再完成校验", async () => {
    const { service, store, credentials, controlStore } = makeService();
    const app = await credentials.apps.create({ tenantId, display_name: "x" });
    const { token } = await service.issueToken((await credentials.apps.get(tenantId, app.app_key))!);
    const original = credentials.tokens.isRevoked;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    credentials.tokens.isRevoked = async (claimTenantId, jti) => {
      await gate;
      return await original(claimTenantId, jti);
    };

    let settled = false;
    const verification = service.requireBearer(bearerRequest(token)).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(verification).resolves.toMatchObject({ sub: app.app_key });
    store.close();
    controlStore.close();
  });

  it("拒绝过短密钥", () => {
    const { store, credentials, controlStore } = makeService();
    expect(() => createWidgetAuthService("short", credentials)).toThrow();
    store.close();
    controlStore.close();
  });
});
