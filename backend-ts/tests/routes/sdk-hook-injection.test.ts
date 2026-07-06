import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import { buildTestHarness } from "../helpers/app.js";
import { mockLlm } from "../helpers/llm-fetch-mock.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (app) {
    await app.close();
    app = null;
  }
});

async function createDefaultChatProvider(app: FastifyInstance): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/model-adapter/providers",
    payload: { name: "my", provider_type: "deepseek", api_key: "sk-test", model_map: { chat: "deepseek-chat" } },
  });
  expect(res.statusCode).toBe(200);
}

async function waitFor(fn: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("waitFor timed out");
}

describe("hook 透传到 backend（round.before 注入）", () => {
  it("backend 注册的 round.before hook 注入 additionalContext，进入 LLM 请求", async () => {
    const llm = mockLlm({ contents: ["done"] });
    const INJECT_MARKER = "<hook-injected-context>HOOK_CONTEXT_BODY</hook-injected-context>";
    const harness = await buildTestHarness({
      hooks: (registry) => {
        registry.on("round.before", () => ({ additionalContext: INJECT_MARKER }));
      },
    });
    app = harness.app;

    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: { "x-request-id": "req-hook-inject" },
      payload: { task: "hello", session_id: "hook-inject-session" },
    });
    expect(started.statusCode).toBe(200);

    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("hook-inject-session").task_info?.status === "completed",
    );

    expect(llm.requests.length).toBeGreaterThanOrEqual(1);
    const requestMessages = (llm.requests[0]!.body?.messages ?? []) as Array<{ role?: string; content?: string }>;
    // additionalContext 以 user role + <additional_context> 标签注入(deepseek 走 chat completions 透传)。
    const injected = requestMessages.find(
      (message) => typeof message.content === "string" && message.content.includes(INJECT_MARKER),
    );
    expect(injected).toBeDefined();
    expect(injected!.role).toBe("user");
  });
});
