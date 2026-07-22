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

// 验证:prompt 模式斜杠命令(/review 等)展开成完整 prompt 发给 LLM,但持久化的 user 消息存用户原始输入
// (刷新后前端显示原始命令 /review X,而非展开后的模板文本)。
describe("/review prompt 命令:持久化原始输入,LLM 收展开 prompt", () => {
  it("user 消息存原始 /review 命令;LLM 请求含展开后的审查 prompt", async () => {
    const llm = mockLlm({ contents: ["审查完成"] });
    const harness = await buildTestHarness();
    app = harness.app;
    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: { task: "/review 未提交代码", session_id: "prompt-session" },
    });
    expect(started.statusCode).toBe(200);
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("prompt-session").task_info?.status === "completed",
    );

    // LLM 收到展开后的 prompt(模板文案 + args),证明 llmTask 走的是展开文本
    expect(llm.requests).toHaveLength(1);
    const messages = (llm.requests[0]!.body?.messages ?? []) as Array<{ content?: string }>;
    const llmHistory = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(llmHistory).toContain("代码审查");
    expect(llmHistory).toContain("未提交代码");

    // 持久化的 user 消息存原始命令(刷新后前端显示这个,而非展开文本);展开 prompt 进 metadata.expanded_task
    const userMessages = harness.localInfrastructure.conversationStore
      .getRecentMessages("prompt-session")
      .filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content).toBe("/review 未提交代码");
    expect(userMessages[0]!.metadata?.msg_type).toBe("command");
    expect(userMessages[0]!.metadata?.command).toBe("review");
    expect(userMessages[0]!.metadata?.command_mode).toBe("prompt");
    expect(userMessages[0]!.metadata?.expanded_task).toContain("代码审查");

    // context-snapshot 的 conversation_history 走 LLM 实际收到的 conversation(投影后),应显示展开后的 prompt,
    // 且 seq 对齐原始命令消息(而非展开文本)。
    const snapshot = await app.inject({
      method: "GET",
      url: "/api/agent/context-snapshot?session_id=prompt-session",
    });
    expect(snapshot.statusCode).toBe(200);
    const historyItems = snapshot.json().data.conversation_history as Array<{
      role: string;
      content_preview: string;
      seq: number | null;
      msg_type: string | null;
    }>;
    const userItem = historyItems.find((h) => h.role === "user");
    expect(userItem).toBeDefined();
    expect(userItem!.content_preview).toContain("代码审查");
    expect(userItem!.seq).toBe(userMessages[0]!.seq);
    expect(userItem!.msg_type).toBe("command");
  });
});
