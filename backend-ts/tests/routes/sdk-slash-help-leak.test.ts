import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { LlmClient, LlmRequest, LlmResult } from "@ragsystem/agent-llm";
import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

class FakeChatClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly content = "ok") {}
  async complete(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    return { content: this.content };
  }
}

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

// 验证：/help 的 command_result 消息不应泄漏进后续 run 的 LLM 请求历史。
describe("/help 不泄漏进 agent 历史", () => {
  it("/help 后的普通消息 run：LLM 请求历史不含 /help 命令表", async () => {
    const chatClient = new FakeChatClient("没有上下文");
    const harness = await buildTestHarness({ llmClient: chatClient });
    app = harness.app;
    await createDefaultChatProvider(app);

    // 1) /help（backend 拦截，产静态命令表，落 command_result 消息，不调 LLM）
    const help = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: { task: "/help", session_id: "leak-session" },
    });
    expect(help.statusCode).toBe(200);
    expect(chatClient.requests).toHaveLength(0); // /help 不调 LLM

    // 2) 普通消息 → 启动 run → 调 LLM
    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: { "x-request-id": "req-leak" },
      payload: { task: "你看得见上下文吗？", session_id: "leak-session" },
    });
    expect(started.statusCode).toBe(200);
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("leak-session").task_info?.status === "completed",
    );

    expect(chatClient.requests).toHaveLength(1);
    const history = chatClient.requests[0]!.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    // /help 交互（命令表 + command_result）不应出现在 LLM 收到的历史里
    expect(history).not.toContain("/help");
    expect(history).not.toContain("可用命令");
    expect(history).not.toContain("/review");
  });
});
