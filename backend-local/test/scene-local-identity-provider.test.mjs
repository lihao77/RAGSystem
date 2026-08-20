import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SceneLocalIdentityProvider } from "../dist/adapters/local/identity/scene-local-identity-provider.js";
import { createControlStore } from "../dist/adapters/local/sqlite/control-store/index.js";
import { SqliteControlPlaneAdapter } from "../dist/adapters/local/sqlite/sqlite-control-plane-adapter.js";

async function withControlPlane(run) {
  const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-scene-identity-"));
  const store = createControlStore(systemRoot);
  const adapter = new SqliteControlPlaneAdapter(store);
  try {
    await run(adapter);
  } finally {
    store.close();
    fs.rmSync(systemRoot, { recursive: true, force: true });
  }
}

test("resolves the default scene when the active setting is missing", async () => {
  await withControlPlane(async (adapter) => {
    const identity = await new SceneLocalIdentityProvider(adapter).resolve({});
    assert.equal(identity.tenantId, "tnt_local");
    assert.equal(identity.userId, "usr_local");
    assert.equal(identity.role, "owner");
    assert.equal(identity.platformRole, "admin");
    // initialize 幂等创建默认租户与本地用户
    assert.ok(await adapter.tenants.get("tnt_local"));
  });
});

test("resolves the stored active scene when it exists and is active", async () => {
  await withControlPlane(async (adapter) => {
    await adapter.tenants.create({ id: "tnt_custom", displayName: "Custom" });
    await adapter.settings.set("local_active_tenant", "tnt_custom");
    const identity = await new SceneLocalIdentityProvider(adapter).resolve({});
    assert.equal(identity.tenantId, "tnt_custom");
  });
});

test("falls back to the default scene when the setting points to a deleted tenant", async () => {
  await withControlPlane(async (adapter) => {
    await adapter.tenants.create({ id: "tnt_gone", displayName: "Gone" });
    await adapter.settings.set("local_active_tenant", "tnt_gone");
    await adapter.tenants.delete("tnt_gone");
    const identity = await new SceneLocalIdentityProvider(adapter).resolve({});
    assert.equal(identity.tenantId, "tnt_local");
  });
});

test("falls back to the default scene when the setting value is malformed", async () => {
  await withControlPlane(async (adapter) => {
    await adapter.settings.set("local_active_tenant", "not-a-tenant-id");
    const identity = await new SceneLocalIdentityProvider(adapter).resolve({});
    assert.equal(identity.tenantId, "tnt_local");
  });
});

test("falls back to the default scene when the stored tenant is suspended", async () => {
  await withControlPlane(async (adapter) => {
    await adapter.tenants.create({ id: "tnt_paused", displayName: "Paused" });
    await adapter.tenants.setStatus("tnt_paused", "suspended");
    await adapter.settings.set("local_active_tenant", "tnt_paused");
    const identity = await new SceneLocalIdentityProvider(adapter).resolve({});
    assert.equal(identity.tenantId, "tnt_local");
  });
});
