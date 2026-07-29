import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { backendPluginModule } from "../dist/index.js";

test("Widget module owns Local credential storage wiring", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE tenants(id TEXT PRIMARY KEY)");
  const manager = new BackendPluginManager([
    await backendPluginModule.create({ config: {} }),
  ]);
  try {
    await manager.register();
    await manager.initializeApplication({
      logger: {},
      registry: {},
      resources: [
        resource(BACKEND_HOST_RESOURCES.deployment, { kind: "local" }),
        resource(BACKEND_HOST_RESOURCES.controlDatabase, db),
        resource(BACKEND_HOST_RESOURCES.wsTickets, {}),
        resource(BACKEND_HOST_RESOURCES.applications, {}),
      ],
    });
    await manager.start();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    assert.ok(tables.includes("widget_apps"));
    assert.ok(tables.includes("widget_tokens"));
  } finally {
    await manager.stop();
    db.close();
  }
});

test("Widget module owns JWT configuration and AG-UI contribution", async () => {
  const plugin = await backendPluginModule.create({
    config: {
      jwtKeyRing: {
        active: { kid: "test", secret: "12345678901234567890123456789012" },
        previous: [],
      },
    },
  });
  const manager = new BackendPluginManager([plugin]);
  await manager.register();
  assert.deepEqual(manager.routes("public").map((route) => route.prefix), ["/api/widget", "/api/agui"]);
});

test("Widget module rejects unknown install configuration", () => {
  assert.throws(
    () => backendPluginModule.create({ config: { unknown: true } }),
    /Unknown Widget plugin configuration/,
  );
});

function resource(kind, value) {
  return { pluginId: "test-host", kind, value };
}
