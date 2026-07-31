import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHookRegistry } from "@ragsystem/agent-sdk";
import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import { backendPluginModule } from "../dist/index.js";

test("Artifacts module owns Local storage wiring", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-module-"));
  const manager = new BackendPluginManager([
    await backendPluginModule.create({ config: undefined }),
  ]);
  try {
    await manager.register();
    await manager.initializeApplication({
      logger: {},
      registry: {},
      resources: [
        resource(BACKEND_HOST_RESOURCES.deployment, { kind: "local" }),
        resource(BACKEND_HOST_RESOURCES.tenantDataRoot, () => root),
      ],
    });
    await manager.start();
    const hooks = createHookRegistry();
    manager.installHooks(hooks);
    const output = await hooks.emit("tool.after", {
      toolName: "execute_skill_script",
      arguments: {},
      result: toolResult(),
      ctx: { tenantId: "tenant-a", sessionId: "session-a", runId: "run-a" },
    });
    assert.equal(output.modifiedResult.metadata.artifact_persisted, true);
    assert.equal(findJsonFiles(root).length, 1);
  } finally {
    await manager.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Artifacts module owns SaaS migrations", async () => {
  const statements = [];
  const manager = new BackendPluginManager([
    await backendPluginModule.create({ config: undefined }),
  ]);
  await manager.register();
  await manager.initializeApplication({
    logger: {},
    registry: {},
    resources: [
      resource(BACKEND_HOST_RESOURCES.deployment, { kind: "saas" }),
      resource(BACKEND_HOST_RESOURCES.runtimeDatabase, fakeExecutor(statements)),
      resource(BACKEND_HOST_RESOURCES.objectStorage, {}),
    ],
  });
  await manager.start();
  assert.ok(statements.some((sql) => sql.includes("artifact_schema_migrations")));
  await manager.stop();
});

function resource(kind, value) {
  return { pluginId: "test-host", kind, value };
}

function toolResult() {
  return {
    success: true,
    toolName: "execute_skill_script",
    summary: "done",
    answer: null,
    outputType: "json",
    content: {
      artifact: {
        schema_version: 2,
        kind: "chart.echarts",
        subtype: "bar",
        title: "Demo",
        presentations: [{ presentation_id: "primary", surface: "chart", renderer: "chart.echarts", assets: {}, config: { series: [1] } }],
      },
    },
    metadata: {},
    artifacts: [],
    llmHint: null,
  };
}

function findJsonFiles(root) {
  return fs.readdirSync(root, { recursive: true }).filter((entry) => String(entry).endsWith(".json"));
}

function fakeExecutor(statements) {
  const executor = {
    async query(sql) {
      statements.push(sql);
      return { rows: [] };
    },
    async transaction(operation) {
      return operation(executor);
    },
  };
  return executor;
}
