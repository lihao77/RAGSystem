import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import {
  createWidgetCredentialStore,
  createWidgetPlugin,
  runPostgresWidgetMigrations,
  SqliteWidgetCredentialAdapter,
} from "../dist/index.js";

test("Widget routes are contributed only by the plugin and AG-UI override follows key configuration", async () => {
  const disabled = new BackendPluginManager([createWidgetPlugin(dependencies())]);
  await disabled.register();
  assert.deepEqual(disabled.routes("management").map((route) => route.prefix), ["/api/widget/apps"]);
  assert.deepEqual(disabled.routes("public").map((route) => route.prefix), ["/api/widget"]);

  const enabled = new BackendPluginManager([createWidgetPlugin(dependencies({ keyRing: keyRing() }))]);
  await enabled.register();
  assert.deepEqual(enabled.routes("public").map((route) => route.prefix), ["/api/widget", "/api/agui"]);
});

test("Widget plugin owns credential pruning lifecycle", async () => {
  let starts = 0;
  let stops = 0;
  const manager = new BackendPluginManager([createWidgetPlugin(dependencies({
    credentials: () => credentials({
      startPruning: async () => { starts += 1; },
      close: async () => { stops += 1; },
    }),
  }))]);
  await manager.register();
  await manager.initializeApplication({ logger: {}, registry: {} });
  await manager.start();
  assert.equal(starts, 1);
  await manager.stop();
  assert.equal(stops, 1);
});

test("Widget SQLite storage owns its schema and credentials", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tenants(id TEXT PRIMARY KEY); INSERT INTO tenants(id) VALUES ('tnt_local')");
  const repository = new SqliteWidgetCredentialAdapter(createWidgetCredentialStore(db));
  const created = await repository.apps.create({
    tenantId: "tnt_local",
    display_name: "Demo",
    allowed_origins: ["https://example.test"],
  });
  assert.equal((await repository.apps.list("tnt_local")).length, 1);
  assert.equal((await repository.apps.verifySecret("tnt_local", created.app_key, created.secret))?.display_name, "Demo");
  await repository.close();
  db.close();
});

test("Widget PostgreSQL migrations are owned by the plugin", async () => {
  const statements = [];
  await runPostgresWidgetMigrations({ query: async (sql) => { statements.push(sql); return { rows: [] }; } });
  assert.match(statements.join("\n"), /CREATE TABLE IF NOT EXISTS control_widget_apps/);
  assert.match(statements.join("\n"), /CREATE TABLE IF NOT EXISTS control_widget_tokens/);
});

test("Widget plugin resolves session origin labels through the generic event hook", async () => {
  const manager = new BackendPluginManager([createWidgetPlugin(dependencies({
    credentials: () => credentials({
      apps: { list: async () => [{ app_key: "wid_pk_demo", display_name: "Demo Widget" }] },
    }),
  }))]);
  await manager.register();
  await manager.initializeApplication({ logger: {}, registry: {} });
  const names = new Map();
  await manager.emit("session.origins.resolve", { tenantId: "tnt_local", names });
  assert.equal(names.get("widget:wid_pk_demo"), "Demo Widget");
  await manager.stop();
});

function dependencies(overrides = {}) {
  return {
    credentials: () => credentials(),
    wsTickets: {},
    applications: {},
    ...overrides,
  };
}

function credentials(overrides = {}) {
  return new Proxy({
    startPruning: async () => undefined,
    stop: async () => undefined,
    close: async () => undefined,
    ...overrides,
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return new Proxy({}, { get: () => async () => null });
    },
  });
}

function keyRing() {
  const key = { kid: "test", secret: new Uint8Array(32).fill(7) };
  return {
    getActiveSigningKey: () => key,
    getVerificationKey: () => key,
    readiness: () => ({ ready: true, activeKid: key.kid, verificationKids: [key.kid] }),
  };
}
