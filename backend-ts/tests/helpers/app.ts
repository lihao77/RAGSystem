import path from "node:path";

import { buildApp } from "../../src/app.js";
import type { AppEnv } from "../../src/config/env.js";
import { createRuntimeContainer } from "../../src/services/runtime/runtime-container.js";
import type { AgentExecutionLogger } from "../../src/services/agent/execution/index.js";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import { makeTempRoot } from "./temp-db.js";

/**
 * 当前测试 dataRoot(buildTestHarness 每次更新)。artifact 等需直接写文件的 fixture
 * 用它与 container.dataRoot 保持一致(避免 fixture 写固定 .test-data 而 container 读临时目录)。
 */
export let testDataRoot = ".test-data";

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
  const tempRoot = makeTempRoot();
  testDataRoot = tempRoot;
  const container = createRuntimeContainer({
    dbPath: path.join(tempRoot, "test.db"),
    dataRoot: tempRoot,
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
