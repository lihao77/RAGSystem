import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { ChatCompletionRequest, LlmChatClient } from "../../src/services/integrations/llm-chat-client.js";
import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("session checkpoint routes", () => {
  it("lists checkpoints with Python-compatible response shape", async () => {
    const harness = await buildTestHarness();
    app = harness.app;

    harness.container.checkpointManager.saveCheckpoint({
      sessionId: "s1",
      agentName: "qa_agent",
      round: 1,
      messages: [{ role: "user", content: "first" }],
    });
    harness.container.checkpointManager.saveCheckpoint({
      sessionId: "s1",
      agentName: "qa_agent",
      round: 2,
      messages: [{ role: "user", content: "second" }],
    });
    harness.container.checkpointManager.saveCheckpoint({
      sessionId: "s1",
      agentName: "other_agent",
      round: 3,
      messages: [{ role: "user", content: "other" }],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/s1/checkpoints?agent_name=qa_agent&limit=1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      message: "获取检查点列表成功",
      data: {
        checkpoints: [
          {
            checkpoint_id: "s1_qa_agent_r2",
            session_id: "s1",
            agent_name: "qa_agent",
            round: 2,
          },
        ],
      },
    });
  });

  it("starts checkpoint recovery with checkpoint messages as runtime context", async () => {
    const chatClient = new FakeChatClient("recovered answer");
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    harness.container.sessionApplication.createSession({ sessionId: "s1" });
    harness.container.sessionApplication.addMessage({
      sessionId: "s1",
      role: "user",
      content: "current session tail that should not be replayed",
    });
    harness.container.checkpointManager.saveCheckpoint({
      sessionId: "s1",
      agentName: "orchestrator_agent",
      round: 2,
      messages: [
        { role: "user", content: "checkpoint question" },
        { role: "assistant", content: "checkpoint draft" },
      ],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/s1/recover",
      headers: {
        "x-request-id": "req-recover-1",
      },
      payload: { checkpoint_id: "s1_orchestrator_agent_r2" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      message: "从检查点恢复已启动",
      data: {
        started: true,
        checkpoint_id: "s1_orchestrator_agent_r2",
        round: 2,
        status: "started",
        request_id: "req-recover-1",
        success: true,
        answer: null,
        error: null,
      },
    });

    await waitFor(() => harness.container.agentExecution.getSessionTaskStatus("s1").task_info?.status === "completed");

    expect(chatClient.requests).toHaveLength(1);
    const requestText = chatClient.requests[0]?.messages.map((message) => message.content).join("\n") ?? "";
    expect(requestText).toContain("checkpoint question");
    expect(requestText).toContain("checkpoint draft");
    expect(requestText).not.toContain("current session tail that should not be replayed");

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/s1/messages?expand=1",
    });
    expect(messages.json().data.items.at(-1)).toMatchObject({
      role: "assistant",
      content: "recovered answer",
      metadata: {
        recovered_from: "s1_orchestrator_agent_r2",
        execution_kind: "checkpoint_recovery",
      },
      execution_steps: expect.arrayContaining([
        expect.objectContaining({
          kind: "run",
          phase: "start",
          recovered_from: "s1_orchestrator_agent_r2",
        }),
        expect.objectContaining({ kind: "final", phase: "complete" }),
      ]),
    });
  });
});

class FakeChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly content: string) {}

  async complete(request: ChatCompletionRequest) {
    this.requests.push(request);
    return { content: this.content };
  }
}

async function createDefaultChatProvider(app: FastifyInstance): Promise<void> {
  const provider = await app.inject({
    method: "POST",
    url: "/api/model-adapter/providers",
    payload: {
      name: "my",
      provider_type: "deepseek",
      api_key: "sk-test",
      model_map: {
        chat: "deepseek-chat",
      },
    },
  });
  expect(provider.statusCode).toBe(200);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
