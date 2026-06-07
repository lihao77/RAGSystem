import { buildApp } from "../../src/app.js";
import type { AppEnv } from "../../src/config/env.js";
import { createRuntimeContainer } from "../../src/services/runtime/runtime-container.js";
import type { LlmChatClient } from "../../src/services/integrations/llm-chat-client.js";
import type { TerminalEventDeliveryMode } from "../../src/services/runtime/event-delivery-mode.js";

export const testEnv: AppEnv = {
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  nodeEnv: "test",
  corsOrigins: true,
  dataRoot: ".test-data",
  dbPath: ":memory:",
  checkpointDbPath: ":memory:",
  terminalEventDelivery: "outbox_live",
};

export async function buildTestApp() {
  const { app } = await buildTestHarness();
  return app;
}

export async function buildTestHarness(
  options: {
    llmChatClient?: LlmChatClient;
    terminalEventDelivery?: TerminalEventDeliveryMode;
    startOutboxDispatcher?: boolean;
  } = {},
) {
  const container = createRuntimeContainer({
    dbPath: ":memory:",
    checkpointDbPath: ":memory:",
    dataRoot: testEnv.dataRoot,
    llmChatClient: options.llmChatClient,
    modelAdapterProvidersConfigPath: "",
    agentConfigRoot: "",
    terminalEventDelivery: options.terminalEventDelivery,
    startOutboxDispatcher: options.startOutboxDispatcher ?? false,
  });
  const app = await buildApp({ env: testEnv, container });
  await app.ready();
  return { app, container };
}
