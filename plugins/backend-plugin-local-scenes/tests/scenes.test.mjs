import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";

import { createControlStore } from "@ragsystem/backend-local/adapters/local/sqlite/control-store/index.js";
import { SqliteControlPlaneAdapter } from "@ragsystem/backend-local/adapters/local/sqlite/sqlite-control-plane-adapter.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { createLocalScenesPlugin } from "../dist/plugin.js";
import { registerLocalSceneRoutes } from "../dist/scenes.js";

function setup() {
  const systemRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-scenes-sys-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-scenes-data-"));
  const store = createControlStore(systemRoot);
  const controlPlane = new SqliteControlPlaneAdapter(store);
  const closedTenants = [];
  const registry = { closeTenant: async (tenantId) => closedTenants.push(tenantId) };
  const tenantDataRoot = (tenantId) => path.join(dataRoot, tenantId);
  return { systemRoot, dataRoot, store, controlPlane, registry, tenantDataRoot, closedTenants };
}

async function withApp(options, run) {
  const ctx = setup();
  try {
    const app = Fastify();
    // 生产环境由 core-app 全局错误处理器把 ZodError 映射为 400；独立装配时补同款映射。
    app.setErrorHandler((error, _request, reply) => {
      if (error?.name === "ZodError") {
        reply.code(400).send({ success: false, message: "validation error" });
        return;
      }
      reply.code(error?.statusCode ?? 500).send({
        success: false,
        message: error?.message ?? "internal error",
        code: error?.code,
      });
    });
    await app.register(registerLocalSceneRoutes, { ...options, ...ctx, enabled: options.enabled });
    await app.ready();
    await run(app, ctx);
    await app.close();
  } finally {
    ctx.store.close();
    fs.rmSync(ctx.systemRoot, { recursive: true, force: true });
    fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
  }
}

test("returns 404 for every scene endpoint when the deployment is not local", async () => {
  await withApp({ enabled: false }, async (app) => {
    const list = await app.inject({ method: "GET", url: "/" });
    assert.equal(list.statusCode, 404);
    const create = await app.inject({ method: "POST", url: "/", payload: { displayName: "X" } });
    assert.equal(create.statusCode, 404);
  });
});

test("lists scenes with the fallback active id on a fresh store", async () => {
  await withApp({ enabled: true }, async (app) => {
    const response = await app.inject({ method: "GET", url: "/" });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.scenes, []);
    assert.equal(body.activeTenantId, "tnt_local");
  });
});

test("creates a scene, activates it, and reports it as active", async () => {
  await withApp({ enabled: true }, async (app, ctx) => {
    const created = await app.inject({ method: "POST", url: "/", payload: { displayName: "工作场景" } });
    assert.equal(created.statusCode, 200);
    const scene = created.json().scene;
    assert.match(scene.id, /^tnt_[a-z0-9]+$/);
    assert.equal(scene.displayName, "工作场景");

    const activated = await app.inject({ method: "POST", url: `/${scene.id}/activate` });
    assert.equal(activated.statusCode, 200);
    assert.equal(activated.json().tenantId, scene.id);

    const membership = await ctx.controlPlane.memberships.get("usr_local", scene.id);
    assert.equal(membership.role, "owner");

    const list = await app.inject({ method: "GET", url: "/" });
    assert.equal(list.json().activeTenantId, scene.id);
    assert.equal(list.json().scenes.length, 1);
  });
});

test("rejects activating an unknown scene or a malformed id", async () => {
  await withApp({ enabled: true }, async (app) => {
    const unknown = await app.inject({ method: "POST", url: "/tnt_missing/activate" });
    assert.equal(unknown.statusCode, 404);
    const malformed = await app.inject({ method: "POST", url: "/not-a-tenant/activate" });
    assert.equal(malformed.statusCode, 400);
  });
});

test("rejects create requests with an empty display name", async () => {
  await withApp({ enabled: true }, async (app) => {
    const response = await app.inject({ method: "POST", url: "/", payload: { displayName: "  " } });
    assert.equal(response.statusCode, 400);
  });
});

test("renames a scene", async () => {
  await withApp({ enabled: true }, async (app) => {
    const scene = (await app.inject({ method: "POST", url: "/", payload: { displayName: "旧名" } })).json().scene;
    const renamed = await app.inject({ method: "PATCH", url: `/${scene.id}`, payload: { displayName: "新名" } });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json().scene.displayName, "新名");
  });
});

test("deletes a non-active scene and removes its data directory", async () => {
  await withApp({ enabled: true }, async (app, ctx) => {
    const first = (await app.inject({ method: "POST", url: "/", payload: { displayName: "A" } })).json().scene;
    const second = (await app.inject({ method: "POST", url: "/", payload: { displayName: "B" } })).json().scene;
    await app.inject({ method: "POST", url: `/${first.id}/activate` });

    const markerDir = ctx.tenantDataRoot(second.id);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, "marker.txt"), "data", "utf8");

    const removed = await app.inject({ method: "DELETE", url: `/${second.id}` });
    assert.equal(removed.statusCode, 200);
    assert.ok(ctx.closedTenants.includes(second.id));
    assert.equal(await ctx.controlPlane.tenants.get(second.id), null);
    assert.equal(await ctx.controlPlane.memberships.get("usr_local", second.id), null);
    assert.equal(fs.existsSync(markerDir), false);
  });
});

test("refuses to delete the active scene", async () => {
  await withApp({ enabled: true }, async (app) => {
    const scene = (await app.inject({ method: "POST", url: "/", payload: { displayName: "A" } })).json().scene;
    await app.inject({ method: "POST", url: `/${scene.id}/activate` });
    const response = await app.inject({ method: "DELETE", url: `/${scene.id}` });
    assert.equal(response.statusCode, 409);
  });
});

test("refuses to delete the last remaining scene", async () => {
  await withApp({ enabled: true }, async (app) => {
    // 唯一场景但未激活（活动解析回落 tnt_local），命中"至少保留一个"守卫。
    const scene = (await app.inject({ method: "POST", url: "/", payload: { displayName: "Solo" } })).json().scene;
    const response = await app.inject({ method: "DELETE", url: `/${scene.id}` });
    assert.equal(response.statusCode, 409);
  });
});

test("refuses to delete the default scene (identity fallback target)", async () => {
  await withApp({ enabled: true }, async (app, ctx) => {
    await ctx.controlPlane.tenants.create({ id: "tnt_local", displayName: "Local" });
    const other = (await app.inject({ method: "POST", url: "/", payload: { displayName: "Other" } })).json().scene;
    await app.inject({ method: "POST", url: `/${other.id}/activate` });
    // 非激活、非最后一个，仍必须被"默认场景不可删除"守卫拦截。
    const response = await app.inject({ method: "DELETE", url: "/tnt_local" });
    assert.equal(response.statusCode, 409);
    assert.ok(await ctx.controlPlane.tenants.get("tnt_local"));
  });
});

test("GET falls back to tnt_local when the setting points to a suspended scene", async () => {
  await withApp({ enabled: true }, async (app, ctx) => {
    await ctx.controlPlane.tenants.create({ id: "tnt_paused", displayName: "Paused" });
    await ctx.controlPlane.tenants.setStatus("tnt_paused", "suspended");
    await ctx.controlPlane.settings.set("local_active_tenant", "tnt_paused");
    const response = await app.inject({ method: "GET", url: "/" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().activeTenantId, "tnt_local");
  });
});

test("plugin install disables routes when auth_mode is password", async () => {
  const ctx = setup();
  try {
    await ctx.controlPlane.settings.set("auth_mode", "password");
    const installs = [];
    createLocalScenesPlugin().register({
      routes: { register: (scope, prefix, install) => installs.push({ scope, prefix, install }) },
    });
    assert.equal(installs.length, 1);
    assert.equal(installs[0].scope, "public");

    const app = Fastify();
    await installs[0].install(app, {
      host: {
        registry: ctx.registry,
        resources: [
          provideBackendResource(BACKEND_HOST_RESOURCES.controlPlane, ctx.controlPlane, "test-host"),
          provideBackendResource(BACKEND_HOST_RESOURCES.deployment, { kind: "local" }, "test-host"),
        ],
      },
    });
    await app.ready();
    const response = await app.inject({ method: "GET", url: "/" });
    assert.equal(response.statusCode, 404);
    await app.close();
  } finally {
    ctx.store.close();
    fs.rmSync(ctx.systemRoot, { recursive: true, force: true });
    fs.rmSync(ctx.dataRoot, { recursive: true, force: true });
  }
});
