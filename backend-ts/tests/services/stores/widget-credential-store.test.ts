import { afterEach, describe, expect, it, vi } from "vitest";

import { createTenantId } from "../../../src/identity/types.js";
import { createControlStore } from "../../../src/adapters/local/sqlite/control-store/index.js";
import { createWidgetCredentialStore } from "../../../src/adapters/local/sqlite/widget-credential-store/index.js";
import { makeTempRoot } from "../../helpers/temp-db.js";

const tenantA = createTenantId("tnt_widget_a");
const tenantB = createTenantId("tnt_widget_b");

afterEach(() => {
  vi.useRealTimers();
});

function makeStore() {
  const controlStore = createControlStore(makeTempRoot());
  controlStore.createTenant({ id: tenantA, displayName: "A" });
  controlStore.createTenant({ id: tenantB, displayName: "B" });
  return { controlStore, store: createWidgetCredentialStore(controlStore.db) };
}

describe("WidgetCredentialStore", () => {
  it("按租户隔离 app 列表与 CORS 来源", () => {
    const { controlStore, store } = makeStore();
    const appA = store.ops.createApp({ tenantId: tenantA, display_name: "A", allowed_origins: ["https://a.test"] });
    store.ops.createApp({ tenantId: tenantB, display_name: "B", allowed_origins: ["https://b.test"] });

    expect(store.ops.listApps(tenantA).map((app) => app.app_key)).toEqual([appA.app_key]);
    expect(store.ops.listAllowedOrigins(tenantA)).toEqual(["https://a.test"]);
    expect(store.ops.listAllowedOrigins(tenantB)).toEqual(["https://b.test"]);

    store.close();
    controlStore.close();
  });

  it("清理过期 token", () => {
    const { controlStore, store } = makeStore();
    const created = store.ops.createApp({ tenantId: tenantA, display_name: "x" });
    store.ops.recordToken({ tenantId: tenantA, jti: "j1", app_key: created.app_key, issued_at: 0, expires_at: 1 });
    store.ops.recordToken({ tenantId: tenantA, jti: "j2", app_key: created.app_key, issued_at: 0, expires_at: 9_999_999_999 });

    expect(store.ops.pruneExpiredTokens(1000)).toBe(1);
    expect(store.ops.isTokenRevoked(tenantA, "j1")).toBe(true);
    expect(store.ops.isTokenRevoked(tenantA, "j2")).toBe(false);
    store.close();
    controlStore.close();
  });

  it("周期清理可幂等启动", () => {
    vi.useFakeTimers();
    const { controlStore, store } = makeStore();
    const created = store.ops.createApp({ tenantId: tenantA, display_name: "x" });
    store.ops.recordToken({ tenantId: tenantA, jti: "expired", app_key: created.app_key, issued_at: 0, expires_at: 1 });
    store.startPruning(60_000);
    store.startPruning(60_000);
    expect(store.ops.isTokenRevoked(tenantA, "expired")).toBe(true);
    store.stop();
    store.close();
    controlStore.close();
  });
});
