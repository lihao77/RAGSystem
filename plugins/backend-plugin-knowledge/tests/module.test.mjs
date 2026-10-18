import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { backendPluginModule, KNOWLEDGE_RUNTIME_CAPABILITY } from "../dist/index.js";

test("Knowledge module starts with local storage and no hosted infrastructure", async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-knowledge-"));
  const manager = new BackendPluginManager([await backendPluginModule.create({ config: undefined })]);
  await manager.register();
  await manager.initializeApplication({ logger: {}, registry: {} });
  await manager.start();
  const runtime = await manager.runtimeContributions().createRuntime({
    deploymentKind: "local", tenantId: "tnt_test", dataRoot,
    backgroundTasks: {}, clientEvents: {}, sessions: { getSession: async () => null },
    systemConfig: { getSection: () => undefined, registerExtension: () => () => undefined },
  });
  t.after(async () => { await runtime.dispose(); await manager.stop(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const capability = runtime.capabilities.require(KNOWLEDGE_RUNTIME_CAPABILITY);
  assert.ok(capability.application);
  assert.equal(fs.existsSync(path.join(dataRoot, "db", "knowledge.db")), true);
});

test("Knowledge module rejects unsupported install configuration", () => {
  assert.throws(() => backendPluginModule.create({ config: { unknown: true } }), /install configuration is not supported/);
});
