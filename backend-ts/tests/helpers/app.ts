import { buildApp } from "../../src/app.js";
import type { AppEnv } from "../../src/config/env.js";
import { createRuntimeContainer } from "../../src/services/runtime-container.js";
import type { LlmChatClient } from "../../src/services/llm-chat-client.js";

export const testEnv: AppEnv = {
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  nodeEnv: "test",
  corsOrigins: true,
  dataRoot: ".test-data",
  dbPath: ":memory:",
  checkpointDbPath: ":memory:",
};

export async function buildTestApp() {
  const { app } = await buildTestHarness();
  return app;
}

export async function buildTestHarness(options: { llmChatClient?: LlmChatClient } = {}) {
  const container = createRuntimeContainer({
    dbPath: ":memory:",
    checkpointDbPath: ":memory:",
    dataRoot: testEnv.dataRoot,
    llmChatClient: options.llmChatClient,
    modelAdapterProvidersConfigPath: "",
  });
  const app = await buildApp({ env: testEnv, container });
  await app.ready();
  return { app, container };
}
