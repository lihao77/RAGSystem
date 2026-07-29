import assert from "node:assert/strict";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { backendPluginModule } from "../dist/index.js";

test("Daemon/Feishu module owns Local repository wiring", async () => {
  let startupReads = 0;
  const store = new Proxy({
    getAllEnabledFeishuBots() {
      startupReads += 1;
      return [];
    },
    findDueCronTasks() { return []; },
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return () => null;
    },
  });
  const manager = new BackendPluginManager([
    await backendPluginModule.create({ config: undefined }),
  ]);
  await manager.register();
  await manager.initializeApplication({
    logger: {},
    registry: {},
    resources: [
      resource(BACKEND_HOST_RESOURCES.deployment, { kind: "local" }),
      resource(BACKEND_HOST_RESOURCES.controlStore, store),
      resource(BACKEND_HOST_RESOURCES.controlPlane, { audit: {} }),
    ],
  });
  await manager.start();
  assert.equal(startupReads, 1);
  assert.deepEqual(manager.routes("management").map((route) => route.prefix), ["/api/bots"]);
  await manager.stop();
});

test("Daemon/Feishu module rejects unsupported install configuration", () => {
  assert.throws(
    () => backendPluginModule.create({ config: { unknown: true } }),
    /install configuration is not supported/,
  );
});

function resource(kind, value) {
  return { pluginId: "test-host", kind, value };
}
