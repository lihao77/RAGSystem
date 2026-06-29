import { buildApp } from "../../src/app.js";
import type { AppEnv } from "../../src/config/env.js";
import { createRuntimeContainer } from "../../src/services/runtime/runtime-container.js";
import type { AgentExecutionLogger } from "../../src/services/agent/execution/index.js";
import type { HookRegistry } from "@ragsystem/agent-sdk";

export const testEnv: AppEnv = {
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  nodeEnv: "test",
  corsOrigins: true,
  dataRoot: ".test-data",
  dbPath: ":memory:",
};

export async function buildTestApp() {
  const { app } = await buildTestHarness();
  return app;
}

export async function buildTestHarness(
  options: {
    startOutboxDispatcher?: boolean;
    logger?: AgentExecutionLogger;
    hooks?: (registry: HookRegistry) => void;
    widgetJwtSecret?: string;
  } = {},
) {
  const container = createRuntimeContainer({
    dbPath: ":memory:",
    dataRoot: testEnv.dataRoot,
    modelAdapterProvidersConfigPath: "",
    mcpConfigPath: "",
    daemonConfigPath: "",
    systemConfigPath: "",
    agentConfigRoot: "",
    startOutboxDispatcher: options.startOutboxDispatcher ?? false,
    logger: options.logger,
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.widgetJwtSecret ? { widgetJwtSecret: options.widgetJwtSecret } : {}),
  });
  const app = await buildApp({ env: testEnv, container });
  await app.ready();
  return { app, container };
}
