import { describe, expect, it } from "vitest";

import { createControlStore } from "../../src/adapters/local/sqlite/control-store/index.js";
import { SqliteControlPlaneAdapter } from "../../src/adapters/local/sqlite/sqlite-control-plane-adapter.js";
import { SqliteWidgetCredentialAdapter } from "../../src/adapters/local/sqlite/sqlite-widget-credential-adapter.js";
import { createWidgetCredentialStore } from "../../src/adapters/local/sqlite/widget-credential-store/index.js";
import { createWidgetAuthService } from "../../src/services/runtime/jwt-service.js";
import { createJwtKeyRing } from "../../src/services/runtime/jwt-key-ring.js";
import {
  LOCAL_TENANT_ID,
  LOCAL_USER_ID,
  LocalIdentityProvider,
  WidgetIdentityProvider,
} from "../../src/services/identity/index.js";
import { makeTempRoot } from "../helpers/temp-db.js";

const secret = "identity-provider-secret-0123456789abcdef";

describe("IdentityProvider", () => {
  it("Local provider 初始化默认身份与 membership", async () => {
    const controlStore = createControlStore(makeTempRoot());
    const provider = new LocalIdentityProvider(new SqliteControlPlaneAdapter(controlStore));
    const identity = await provider.resolve({} as never);

    expect(identity).toEqual({
      userId: LOCAL_USER_ID,
      tenantId: LOCAL_TENANT_ID,
      role: "owner",
      permissions: ["*"],
      platformRole: "admin",
    });
    expect(controlStore.getTenant(LOCAL_TENANT_ID)).not.toBeNull();
    expect(controlStore.getUser(LOCAL_USER_ID)).not.toBeNull();
    expect(controlStore.getMembership(LOCAL_USER_ID, LOCAL_TENANT_ID)?.role).toBe("owner");
    controlStore.close();
  });

  it("Widget provider 从 bearer claims 解析租户", async () => {
    const controlStore = createControlStore(makeTempRoot());
    await new LocalIdentityProvider(new SqliteControlPlaneAdapter(controlStore)).resolve({} as never);
    const store = createWidgetCredentialStore(controlStore.db);
    const credentials = new SqliteWidgetCredentialAdapter(store);
    const auth = createWidgetAuthService(createJwtKeyRing({ active: { kid: "test", secret } }), credentials);
    const app = store.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "widget" });
    const token = (await auth.issueToken(store.ops.getApp(LOCAL_TENANT_ID, app.app_key)!)).token;
    const provider = new WidgetIdentityProvider(auth, credentials);
    const identity = await provider.resolve({ headers: { authorization: `Bearer ${token}` } } as never);

    expect(identity.tenantId).toBe(LOCAL_TENANT_ID);
    expect(identity.role).toBe("widget");
    store.close();
    controlStore.close();
  });
});
