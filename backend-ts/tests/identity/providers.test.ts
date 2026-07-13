import { describe, expect, it } from "vitest";

import { createControlStore } from "../../src/services/stores/control-store/index.js";
import { createWidgetCredentialStore } from "../../src/services/stores/widget-credential-store/index.js";
import { createWidgetAuthService } from "../../src/services/runtime/jwt-service.js";
import {
  LOCAL_TENANT_ID,
  LOCAL_USER_ID,
  LocalIdentityProvider,
  WidgetIdentityProvider,
} from "../../src/services/identity/index.js";
import { makeTempRoot } from "../helpers/temp-db.js";

const secret = "identity-provider-secret-0123456789abcdef";

describe("IdentityProvider", () => {
  it("Local provider 初始化默认身份与 membership", () => {
    const controlStore = createControlStore(makeTempRoot());
    const provider = new LocalIdentityProvider(controlStore);
    const identity = provider.resolve({} as never);

    expect(identity).toEqual({
      userId: LOCAL_USER_ID,
      tenantId: LOCAL_TENANT_ID,
      role: "owner",
      permissions: ["*"],
    });
    expect(controlStore.getTenant(LOCAL_TENANT_ID)).not.toBeNull();
    expect(controlStore.getUser(LOCAL_USER_ID)).not.toBeNull();
    expect(controlStore.getMembership(LOCAL_USER_ID, LOCAL_TENANT_ID)?.role).toBe("owner");
    controlStore.close();
  });

  it("Widget provider 从 bearer claims 解析租户", () => {
    const controlStore = createControlStore(makeTempRoot());
    new LocalIdentityProvider(controlStore);
    const store = createWidgetCredentialStore(controlStore.db);
    const auth = createWidgetAuthService(secret, store.ops);
    const app = store.ops.createApp({ tenantId: LOCAL_TENANT_ID, display_name: "widget" });
    const token = auth.issueToken(store.ops.getApp(LOCAL_TENANT_ID, app.app_key)!).token;
    const provider = new WidgetIdentityProvider(auth, store);
    const identity = provider.resolve({ headers: { authorization: `Bearer ${token}` } } as never);

    expect(identity.tenantId).toBe(LOCAL_TENANT_ID);
    expect(identity.role).toBe("widget");
    store.close();
    controlStore.close();
  });
});
