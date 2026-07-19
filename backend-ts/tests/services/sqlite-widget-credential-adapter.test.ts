import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteWidgetCredentialAdapter } from "../../src/adapters/local/sqlite/sqlite-widget-credential-adapter.js";
import { createTenantId } from "../../src/identity/types.js";
import { createControlStore } from "../../src/adapters/local/sqlite/control-store/index.js";
import { createWidgetCredentialStore } from "../../src/adapters/local/sqlite/widget-credential-store/index.js";
import { makeTempRoot } from "../helpers/temp-db.js";

const tenantA = createTenantId("tnt_widget_adapter_a");
const tenantB = createTenantId("tnt_widget_adapter_b");

afterEach(() => vi.useRealTimers());

function makeRepository() {
  const controlStore = createControlStore(makeTempRoot());
  controlStore.createTenant({ id: tenantA, displayName: "A" });
  controlStore.createTenant({ id: tenantB, displayName: "B" });
  const store = createWidgetCredentialStore(controlStore.db);
  const credentials = new SqliteWidgetCredentialAdapter(store);
  return { controlStore, store, credentials };
}

describe("SqliteWidgetCredentialAdapter", () => {
  it("isolates apps, origins, tokens and audit by tenant", async () => {
    const { controlStore, store, credentials } = makeRepository();
    try {
      const appA = await credentials.apps.create({
        tenantId: tenantA,
        display_name: "A",
        allowed_origins: ["https://a.test"],
      });
      await credentials.apps.create({
        tenantId: tenantB,
        display_name: "B",
        allowed_origins: ["https://b.test"],
      });
      expect((await credentials.apps.list(tenantA)).map((app) => app.app_key)).toEqual([appA.app_key]);
      await expect(credentials.apps.listAllowedOrigins(tenantA)).resolves.toEqual(["https://a.test"]);

      await credentials.tokens.record({ tenantId: tenantA, jti: "token-a", app_key: appA.app_key, issued_at: 1, expires_at: 100 });
      await expect(credentials.tokens.isRevoked(tenantA, "token-a")).resolves.toBe(false);
      await expect(credentials.tokens.isRevoked(tenantB, "token-a")).resolves.toBe(true);
      await expect(credentials.tokens.revoke(tenantB, "token-a")).resolves.toBe(false);

      await credentials.audit.record(tenantA, {
        app_key: appA.app_key,
        action: "create",
        actor: "test",
        detail: { origin: "https://a.test" },
      });
      await expect(credentials.audit.list(tenantA, appA.app_key)).resolves.toEqual([
        expect.objectContaining({ app_key: appA.app_key, action: "create", detail: { origin: "https://a.test" } }),
      ]);
      await expect(credentials.audit.list(tenantB, appA.app_key)).resolves.toEqual([]);
    } finally {
      await credentials.close();
      store.close();
      controlStore.close();
    }
  });

  it("rotates and revokes an app atomically with all issued tokens", async () => {
    const { controlStore, store, credentials } = makeRepository();
    try {
      const created = await credentials.apps.create({ tenantId: tenantA, display_name: "Rotate" });
      await credentials.tokens.record({ tenantId: tenantA, jti: "before-rotate", app_key: created.app_key, issued_at: 1, expires_at: 100 });
      const rotated = await credentials.apps.rotateSecret(tenantA, created.app_key);
      expect(rotated?.secret).not.toBe(created.secret);
      await expect(credentials.tokens.isRevoked(tenantA, "before-rotate")).resolves.toBe(true);

      await credentials.tokens.record({ tenantId: tenantA, jti: "before-revoke", app_key: created.app_key, issued_at: 2, expires_at: 100 });
      await expect(credentials.apps.revoke(tenantA, created.app_key)).resolves.toBe(true);
      await expect(credentials.tokens.isRevoked(tenantA, "before-revoke")).resolves.toBe(true);
      await expect(credentials.apps.verifySecret(tenantA, created.app_key, rotated!.secret)).resolves.toBeNull();
    } finally {
      await credentials.close();
      store.close();
      controlStore.close();
    }
  });

  it("prunes expired tokens immediately and starts only one timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { controlStore, store, credentials } = makeRepository();
    try {
      const created = await credentials.apps.create({ tenantId: tenantA, display_name: "Prune" });
      await credentials.tokens.record({ tenantId: tenantA, jti: "expired", app_key: created.app_key, issued_at: 0, expires_at: 1 });
      await credentials.startPruning(60_000);
      await credentials.startPruning(60_000);
      await expect(credentials.tokens.isRevoked(tenantA, "expired")).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      await credentials.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await credentials.close();
      store.close();
      controlStore.close();
    }
  });
});
