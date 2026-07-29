import assert from "node:assert/strict";
import test from "node:test";

import { BackendPluginManager } from "@ragsystem/backend-core/plugins/plugin-manager.js";
import { BACKEND_HOST_RESOURCES } from "@ragsystem/backend-core/plugins/host-resources.js";
import {
  backendPluginModule,
  MCP_RUNTIME_CAPABILITY,
} from "../dist/index.js";

test("MCP module owns SaaS runtime wiring and migrations", async () => {
  const statements = [];
  const executor = fakeExecutor(statements);
  const hostResources = [
    resource(BACKEND_HOST_RESOURCES.deployment, { kind: "saas" }),
    resource(BACKEND_HOST_RESOURCES.runtimeDatabase, executor),
    resource(BACKEND_HOST_RESOURCES.secrets, { resolve: async () => null }),
  ];
  const manager = new BackendPluginManager([
    await backendPluginModule.create({ config: undefined }),
  ]);
  await manager.register();
  await manager.initializeApplication({ logger: {}, registry: {}, resources: hostResources });
  await manager.start();
  assert.ok(statements.some((sql) => sql.includes("ragsystem_mcp_schema_migrations")));

  const runtime = await manager.runtimeContributions(hostResources).createRuntime({
    deploymentKind: "saas",
    tenantId: "tenant-a",
  });
  const capability = runtime.capabilities.require(MCP_RUNTIME_CAPABILITY);
  await capability.ready;
  assert.ok(capability.application);
  runtime.dispose();
  await manager.stop();
});

test("MCP module rejects unsupported install configuration", () => {
  assert.throws(
    () => backendPluginModule.create({ config: { unknown: true } }),
    /install configuration is not supported/,
  );
});

function resource(kind, value) {
  return { pluginId: "test-host", kind, value };
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
