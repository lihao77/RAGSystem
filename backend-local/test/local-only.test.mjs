import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadEnv } from "@ragsystem/backend-core/config/env.js";
import { buildCoreApp } from "@ragsystem/backend-core/core-app.js";
import { createLocalScenesPlugin } from "@ragsystem/backend-plugin-local-scenes/plugin.js";
import { createLocalDeploymentRuntime } from "../dist/adapters/local/composition/local-deployment-runtime.js";
import { normalizeLocalControlSettings } from "../dist/adapters/local/sqlite/control-store/control-settings-hydration.js";

for (const historical of [
  {},
  { deployment_mode: "saas", auth_mode: "password", storage_mode: "postgres", execution_mode: "remote", ui_mode: "saas" },
  { deployment_mode: "local", auth_mode: "oidc", storage_mode: "postgres", installed: "false" },
]) {
  test(`control settings converge idempotently: ${JSON.stringify(historical)}`, async () => {
    const values = { ...historical, local_active_tenant: "tnt_work", custom_setting: "preserved" };
    let writes = 0;
    const settings = {
      getAll: async () => ({ ...values }),
      setMany: async (patch) => { writes += 1; Object.assign(values, patch); },
    };
    await normalizeLocalControlSettings(settings);
    await normalizeLocalControlSettings(settings);
    assert.equal(writes, 1);
    assert.deepEqual(values, {
      deployment_mode: "local", auth_mode: "local", tenancy_mode: "single",
      execution_mode: "local", storage_mode: "sqlite", ui_mode: "local", installed: "true",
      local_active_tenant: "tnt_work", custom_setting: "preserved",
    });
  });
}

test("local app keeps scenes across restart and has no hosted account endpoints", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-local-only-"));
  const env = loadEnv({ RAG_DATA_ROOT: root, BACKEND_TS_LOG_LEVEL: "silent" });
  let deployment = await createLocalDeploymentRuntime(env);
  let app = await buildCoreApp({ env, runtime: deployment, plugins: [createLocalScenesPlugin()] });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const bootstrap = (await app.inject("/api/bootstrap")).json();
  assert.equal(bootstrap.deployment, "local");
  assert.equal(bootstrap.installed, true);
  assert.deepEqual(bootstrap.capabilities, {
    login: false, tenantSwitch: false, members: false, billing: false, localExecution: true,
  });
  for (const [method, url] of [
    ["POST", "/api/install"], ["POST", "/api/auth/login"], ["POST", "/api/auth/switch-tenant"],
    ["POST", "/api/auth/logout"], ["GET", "/api/platform/tenants"], ["GET", "/api/admin/tenants"],
  ]) assert.equal((await app.inject({ method, url })).statusCode, 404, url);

  const created = await app.inject({ method: "POST", url: "/api/local/scenes", payload: { displayName: "工作" } });
  assert.equal(created.statusCode, 200, created.body);
  const sceneId = created.json().scene.id;
  assert.equal((await app.inject({ method: "POST", url: `/api/local/scenes/${sceneId}/activate` })).statusCode, 200);
  const identity = (await app.inject("/api/auth/me")).json();
  assert.equal(identity.tenantId, sceneId);
  assert.equal(identity.user.id, "usr_local");
  assert.equal(identity.role, "owner");
  await deployment.controlPlane.settings.setMany({ deployment_mode: "saas", auth_mode: "password", storage_mode: "postgres" });
  await app.close();
  assert.throws(() => deployment.pluginResources.controlDatabase.prepare("SELECT 1"));

  deployment = await createLocalDeploymentRuntime(env);
  app = await buildCoreApp({ env, runtime: deployment, plugins: [createLocalScenesPlugin()] });
  assert.equal((await app.inject("/api/bootstrap")).json().deployment, "local");
  assert.equal((await app.inject("/api/auth/me")).json().tenantId, sceneId);
  const scenes = (await app.inject("/api/local/scenes")).json();
  assert.equal(scenes.activeTenantId, sceneId);
  assert.ok(scenes.scenes.some((scene) => scene.id === sceneId && scene.displayName === "工作"));
  assert.ok(scenes.scenes.some((scene) => scene.id === "tnt_local"));
});
