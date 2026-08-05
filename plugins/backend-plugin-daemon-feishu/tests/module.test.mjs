import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { provideBackendResource } from "@ragsystem/backend-core/plugins/resource-registry.js";
import { backendPluginModule } from "../dist/index.js";

test("Daemon/Feishu module owns Local repository wiring", async () => {
  const database = createControlDatabase();
  const manager = new BackendPluginManager([
    await backendPluginModule.create({ config: undefined }),
  ]);
  await manager.register();
  await manager.initializeApplication({
    logger: {},
    registry: {},
    resources: [
      resource(BACKEND_HOST_RESOURCES.deployment, { kind: "local" }),
      resource(BACKEND_HOST_RESOURCES.controlDatabase, database),
      resource(BACKEND_HOST_RESOURCES.controlPlane, { audit: {} }),
    ],
  });
  await manager.start();
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM ragsystem_plugin_schema_migrations").get().count, 1);
  assert.deepEqual(manager.routes("management").map((route) => route.prefix), ["/api/bots"]);
  await manager.stop();
  database.close();
});

test("Daemon/Feishu module rejects unsupported install configuration", () => {
  assert.throws(
    () => backendPluginModule.create({ config: { unknown: true } }),
    /install configuration is not supported/,
  );
});

function resource(kind, value) {
  return provideBackendResource(kind, value, "test-host");
}

function createControlDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tenants (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      username TEXT,
      password_hash TEXT,
      platform_role TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      type TEXT NOT NULL DEFAULT 'human',
      owner_id TEXT
    );
    CREATE TABLE memberships (
      user_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (user_id, tenant_id)
    );
  `);
  return database;
}
