import assert from "node:assert/strict";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { createDaemonFeishuPlugin } from "../dist/index.js";

test("Daemon/Feishu routes are contributed only when the plugin is installed", async () => {
  const empty = new BackendPluginManager();
  await empty.register();
  assert.deepEqual(empty.routes("management"), []);

  const installed = new BackendPluginManager([
    createDaemonFeishuPlugin({ botRepository: repository(), controlPlane: controlPlane() }),
  ]);
  await installed.register();
  assert.deepEqual(installed.routes("management").map((route) => route.prefix), ["/api/bots"]);
  assert.deepEqual(installed.routes("platform").map((route) => route.prefix), ["/api/platform"]);
});

test("Daemon/Feishu owns its process runtime lifecycle", async () => {
  let startupReads = 0;
  const manager = new BackendPluginManager([
    createDaemonFeishuPlugin({
      botRepository: repository({
        listAllEnabledFeishu: async () => {
          startupReads += 1;
          return [];
        },
      }),
      controlPlane: controlPlane(),
    }),
  ]);
  await manager.register();
  await manager.initializeApplication({ logger: {}, registry: {} });
  await manager.start();
  assert.equal(startupReads, 1);
  await manager.stop();
});

test("generic resource change events refresh matching bot runtime state", async () => {
  let botReads = 0;
  const manager = new BackendPluginManager([
    createDaemonFeishuPlugin({
      botRepository: repository({
        get: async () => {
          botReads += 1;
          return null;
        },
      }),
      controlPlane: controlPlane(),
    }),
  ]);
  await manager.register();
  await manager.initializeApplication({ logger: {}, registry: {} });
  await manager.start();
  await manager.emit("resource.changed", {
    resourceType: "user",
    resourceId: "usr_bot",
    change: "status",
  });
  assert.equal(botReads, 1);
  await manager.stop();
});

test("Daemon plugin resolves bot session origin labels through the generic event hook", async () => {
  const manager = new BackendPluginManager([createDaemonFeishuPlugin({
    botRepository: repository({
      listByTenant: async () => [{ id: "usr_bot_demo", displayName: "Demo Bot" }],
    }),
    controlPlane: controlPlane(),
  })]);
  await manager.register();
  const names = new Map();
  await manager.emit("session.origins.resolve", { tenantId: "tnt_local", names });
  assert.equal(names.get("bot:usr_bot_demo"), "Demo Bot");
});

function repository(overrides = {}) {
  return new Proxy({
    listAllEnabledFeishu: async () => [],
    get: async () => null,
    ...overrides,
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return async () => null;
    },
  });
}

function controlPlane() {
  return { audit: { record: async () => undefined } };
}
