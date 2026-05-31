import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { ChatCompletionRequest, LlmChatClient } from "../../src/services/llm-chat-client.js";
import { buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

class FakeChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];
  private resolver: (() => void) | null = null;

  constructor(private readonly content = "TS runtime answer") {}

  async complete(request: ChatCompletionRequest) {
    this.requests.push(request);
    if (this.resolver) {
      await new Promise<void>((resolve) => {
        this.resolver = resolve;
      });
    }
    if (request.signal?.aborted) {
      throw new Error("aborted");
    }
    return { content: this.content };
  }

  hold(): void {
    this.resolver = () => undefined;
  }

  release(): void {
    this.resolver?.();
  }
}

describe("minimal runtime core execution", () => {
  it("starts a configured single-agent text run and persists the final answer", async () => {
    const chatClient = new FakeChatClient("hello from ts core");
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-1",
      },
      payload: {
        task: "hello",
        session_id: "runtime-session",
      },
    });

    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      success: true,
      data: {
        started: true,
        session_id: "runtime-session",
        request_id: "req-runtime-1",
        kind: "agent_run",
      },
    });

    await waitFor(() => harness.container.agentExecution.getSessionTaskStatus("runtime-session").task_info?.status === "completed");

    expect(chatClient.requests).toHaveLength(1);
    expect(chatClient.requests[0]).toMatchObject({
      model: "deepseek-chat",
      provider: {
        key: "my_deepseek",
      },
    });
    expect(chatClient.requests[0]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system" }),
        expect.objectContaining({ role: "user", content: "hello" }),
      ]),
    );

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/runtime-session/messages?expand=1",
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().data.items).toMatchObject([
      {
        role: "user",
        content: "hello",
      },
      {
        role: "assistant",
        content: "hello from ts core",
        has_execution: true,
        execution_steps: [
          expect.objectContaining({ kind: "run", phase: "start" }),
          expect.objectContaining({ kind: "final", phase: "complete" }),
        ],
      },
    ]);

    const status = await app.inject({
      method: "GET",
      url: `/api/agent/tasks/${started.json().data.task_id}/status`,
    });
    expect(status.json()).toMatchObject({
      data: {
        found: true,
        has_running_task: false,
        task_info: {
          status: "completed",
          thread_alive: false,
        },
      },
    });

    const history = harness.container.events.getHistory("runtime-session");
    const eventTypes = history.map((event) => event.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "output.message_saved",
        "session.run_started",
        "run.start",
        "execution.step",
        "output.final_answer",
        "run.end",
        "session.updated",
      ]),
    );
    expect(history.filter((event) => event.type === "output.message_saved").map((event) => event.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String), seq: expect.any(Number), role: "user" }),
        expect.objectContaining({ id: expect.any(String), seq: expect.any(Number), role: "assistant" }),
      ]),
    );
    expect(history.find((event) => event.type === "execution.step")?.data).toMatchObject({
      kind: "run",
      phase: "start",
    });
    expect(history.find((event) => event.type === "output.final_answer")?.data).toMatchObject({
      content: "hello from ts core",
      metadata: expect.objectContaining({
        run_id: started.json().data.run_id,
        request_id: "req-runtime-1",
        execution_kind: "agent_stream",
        execution_time: expect.any(Number),
      }),
    });
    expect(history.find((event) => event.type === "run.end")?.data).toMatchObject({
      status: "completed",
      final_message_id: expect.any(String),
    });
  });

  it("can interrupt a running minimal runtime-core request", async () => {
    const chatClient = new FakeChatClient();
    chatClient.hold();
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: {
        task: "slow task",
        session_id: "interrupt-session",
      },
    });
    expect(started.statusCode).toBe(200);

    const stopped = await app.inject({
      method: "POST",
      url: "/api/agent/stream/stop",
      payload: {
        session_id: "interrupt-session",
      },
    });
    expect(stopped.statusCode).toBe(200);

    chatClient.release();
    await waitFor(() => harness.container.agentExecution.getSessionTaskStatus("interrupt-session").task_info?.status === "interrupted");

    expect(harness.container.agentExecution.getSessionTaskStatus("interrupt-session")).toMatchObject({
      has_running_task: false,
      task_info: {
        status: "interrupted",
      },
    });
  });
});

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
