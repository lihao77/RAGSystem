import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { ChatCompletionRequest, ChatCompletionResult, LlmChatClient } from "../../src/services/integrations/llm-chat-client.js";
import { buildTestApp, buildTestHarness } from "../helpers/app.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
});

describe("execution compatibility routes", () => {
  it("reports Python-compatible idle task status for sessions while runtime is not migrated", async () => {
    app = await buildTestApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/s1/task-status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      success: true,
      data: {
        session_id: "s1",
        has_running_task: false,
        has_active_system_command: false,
        task_info: null,
        observability: null,
        diagnostics: null,
      },
    });
  });

  it("reports empty execution overview and running task list", async () => {
    app = await buildTestApp();

    const overview = await app.inject({
      method: "GET",
      url: "/api/agent/execution/overview?active_only=false",
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      success: true,
      data: {
        active_only: false,
        count: 0,
        by_execution_kind: {},
        by_status: {},
        sessions: [],
        items: [],
      },
    });

    const running = await app.inject({
      method: "GET",
      url: "/api/agent/tasks/running",
    });
    expect(running.statusCode).toBe(200);
    expect(running.json()).toMatchObject({
      success: true,
      data: {
        active_only: true,
        count: 0,
        items: [],
      },
    });
  });

  it("returns not-found-shaped task diagnostics for unknown task ids", async () => {
    app = await buildTestApp();

    const status = await app.inject({
      method: "GET",
      url: "/api/agent/tasks/task-1/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      success: true,
      data: {
        task_id: "task-1",
        scope: "task_id",
        scope_id: "task-1",
        found: false,
        has_running_task: false,
        task_info: null,
        observability: null,
      },
    });

    const diagnostics = await app.inject({
      method: "GET",
      url: "/api/agent/tasks/task-1/execution-diagnostics",
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toMatchObject({
      success: true,
      data: {
        task_id: "task-1",
        scope: "task_id",
        scope_id: "task-1",
        found: false,
        diagnostics: null,
      },
    });
  });

  it("executes synchronous default and specific-agent requests", async () => {
    const chatClient = new FakeSequenceChatClient(["sync answer", "specific answer"]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;
    await createDefaultChatProvider(app);

    const execute = await app.inject({
      method: "POST",
      url: "/api/agent/execute",
      headers: { "x-request-id": "req-sync-1" },
      payload: {
        task: "hello",
        session_id: "sync-session",
      },
    });
    expect(execute.statusCode).toBe(200);
    expect(execute.json()).toMatchObject({
      success: true,
      message: "任务执行成功",
      data: {
        answer: "sync answer",
        agent_name: "orchestrator_agent",
        session_id: "sync-session",
        metadata: {
          run_id: expect.any(String),
          thread_key: "root",
          child_agent_id: null,
        },
      },
    });

    const executeAgent = await app.inject({
      method: "POST",
      url: "/api/agent/execute/general_agent",
      headers: { "x-request-id": "req-sync-2" },
      payload: {
        task: "hello specific",
        session_id: "sync-session",
      },
    });
    expect(executeAgent.statusCode).toBe(200);
    expect(executeAgent.json()).toMatchObject({
      success: true,
      data: {
        answer: "specific answer",
        agent_name: "general_agent",
        session_id: "sync-session",
      },
    });

    expect(chatClient.requests).toHaveLength(2);
    expect(chatClient.requests[0]?.messages.at(-1)?.content).toContain("hello");
    expect(chatClient.requests[1]?.messages.at(-1)?.content).toContain("hello specific");
  });

  it("executes sequential collaboration and still rejects parallel mode", async () => {
    const chatClient = new FakeSequenceChatClient(["first", "second"]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;
    await createDefaultChatProvider(app);

    const parallel = await app.inject({
      method: "POST",
      url: "/api/agent/collaborate",
      payload: {
        mode: "parallel",
        tasks: [{ task: "hello" }],
      },
    });
    expect(parallel.statusCode).toBe(400);
    expect(parallel.json()).toMatchObject({
      success: false,
      code: "invalid_request",
      message: "并行模式尚未实现",
    });

    const sequential = await app.inject({
      method: "POST",
      url: "/api/agent/collaborate",
      headers: { "x-request-id": "req-collab-1" },
      payload: {
        mode: "sequential",
        session_id: "collab-session",
        tasks: [{ task: "first task" }, { task: "second task", agent: "general_agent" }],
      },
    });
    expect(sequential.statusCode).toBe(200);
    expect(sequential.json()).toMatchObject({
      success: true,
      message: "协作任务执行完成",
      data: {
        session_id: "collab-session",
        total_tasks: 2,
        results: [
          { success: true, content: "first", agent_name: "orchestrator_agent" },
          { success: true, content: "second", agent_name: "general_agent" },
        ],
      },
    });
  });
});

class FakeSequenceChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async complete(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    this.requests.push(request);
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("missing fake LLM response");
    }
    return { content };
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
