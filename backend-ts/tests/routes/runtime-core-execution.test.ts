import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { ChatCompletionRequest, ChatCompletionResult, LlmChatClient } from "../../src/services/llm-chat-client.js";
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

class FakeSequenceChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async complete(request: ChatCompletionRequest) {
    this.requests.push(request);
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("missing fake LLM response");
    }
    return { content };
  }
}

class FakeStreamingChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly chunks: string[]) {}

  async complete(): Promise<{ content: string }> {
    throw new Error("complete should not be called when stream is available");
  }

  async stream(request: ChatCompletionRequest, onChunk: (chunk: { content: string }) => void | Promise<void>) {
    this.requests.push(request);
    let content = "";
    for (const chunk of this.chunks) {
      content += chunk;
      await onChunk({ content: chunk });
    }
    return { content };
  }
}

class FakeToolCallingChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly responses: ChatCompletionResult[]) {}

  async complete(request: ChatCompletionRequest) {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("missing fake LLM response");
    }
    return response;
  }
}

class FakeXmlStreamingToolChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly responses: string[][]) {}

  async complete(): Promise<{ content: string }> {
    throw new Error("complete should not be called for XML streaming tool loops");
  }

  async stream(request: ChatCompletionRequest, onChunk: (chunk: { content: string }) => void | Promise<void>) {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("missing fake XML stream response");
    }
    let content = "";
    for (const chunk of response) {
      content += chunk;
      await onChunk({ content: chunk });
    }
    return { content, finishReason: "stop" };
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
        expect.objectContaining({ role: "system", content: expect.stringContaining("<system_instruction") }),
        expect.objectContaining({ role: "user", content: expect.stringContaining("<user_input") }),
      ]),
    );
    expect(chatClient.requests[0]?.messages.at(-1)?.content).toContain("hello");

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
        "agent.start",
        "call.agent.start",
        "call.agent.end",
        "execution.step",
        "output.final_answer",
        "run.end",
      ]),
    );
    const agentStart = history.find((event) => event.type === "agent.start");
    expect(agentStart).toMatchObject({
      agent_name: "orchestrator_agent",
      call_id: expect.stringMatching(/^call_/),
      data: {
        agent_name: "orchestrator_agent",
        task: "hello",
        description: "hello",
      },
    });
    const rootAgentCalls = history.filter(
      (event) =>
        (event.type === "call.agent.start" || event.type === "call.agent.end") &&
        event.call_id === agentStart?.call_id,
    );
    expect(rootAgentCalls).toEqual([
      expect.objectContaining({
        type: "call.agent.start",
        agent_name: "orchestrator_agent",
        call_id: agentStart?.call_id,
        data: expect.objectContaining({
          agent_name: "orchestrator_agent",
          description: "hello",
          agent_display_name: "Orchestrator Agent",
        }),
      }),
      expect.objectContaining({
        type: "call.agent.end",
        agent_name: "orchestrator_agent",
        call_id: agentStart?.call_id,
        data: expect.objectContaining({
          agent_name: "orchestrator_agent",
          result: "hello from ts core",
          success: true,
          agent_display_name: "Orchestrator Agent",
        }),
      }),
    ]);
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
    expect(history.find((event) => event.type === "context.usage")).toMatchObject({
      agent_name: "orchestrator_agent",
      data: {
        used_tokens: expect.any(Number),
        system_prompt_tokens: expect.any(Number),
        total_tokens: expect.any(Number),
        budget_tokens: 109104,
        round: 0,
        compressing: false,
        request_id: "req-runtime-1",
      },
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

  it("compresses long session history before the main agent request", async () => {
    const chatClient = new FakeSequenceChatClient([
      "<analysis>draft</analysis><summary>旧问题、已完成操作和当前约束</summary>",
      "answer after compression",
    ]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    harness.container.systemConfig.updateConfig({
      context: {
        compression_trigger_ratio: 0.5,
        summarize_max_tokens: 64,
        preserve_recent_turns: 1,
        system_prompt_reserve: 0,
        min_context_budget: 10,
      },
    });
    const config = harness.container.agentConfig.getConfig("orchestrator_agent");
    expect(config).not.toBeNull();
    const behavior = config!.custom_params.behavior as Record<string, unknown> | undefined;
    harness.container.agentConfig.replaceConfig("orchestrator_agent", {
      ...config!,
      custom_params: {
        ...config!.custom_params,
        behavior: {
          ...behavior,
          compression_trigger_ratio: 0.5,
          summarize_max_tokens: 64,
          preserve_recent_turns: 1,
        },
      },
      llm_tiers: {
        default: {
          ...(config!.llm_tiers?.default ?? {}),
          provider: "my",
          provider_type: "deepseek",
          model_name: "deepseek-chat",
          max_context_tokens: 100,
          max_completion_tokens: 1,
          extra_params: config!.llm_tiers?.default?.extra_params ?? {},
        },
      },
      memory: {
        ...config!.memory,
        allowed_scopes: [],
        write_scopes: [],
        archive_scopes: [],
      },
    });

    harness.container.sessionApplication.createSession({ sessionId: "runtime-compress-session" });
    for (const [role, content] of [
      ["user", "old user one ".repeat(20)],
      ["assistant", "old assistant one ".repeat(20)],
      ["user", "old user two ".repeat(20)],
      ["assistant", "tail assistant ".repeat(20)],
      ["user", "tail user ".repeat(20)],
    ] as const) {
      harness.container.sessionApplication.addMessage({
        sessionId: "runtime-compress-session",
        role,
        content,
      });
    }

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-compress",
      },
      payload: {
        task: "continue after compression",
        session_id: "runtime-compress-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(() => harness.container.agentExecution.getSessionTaskStatus("runtime-compress-session").task_info?.status === "completed");

    expect(chatClient.requests).toHaveLength(2);
    expect(chatClient.requests[0]?.messages[0]?.content).toContain("对话摘要助手");
    expect(chatClient.requests[0]?.maxCompletionTokens).toBe(64);
    const mainMessages = chatClient.requests[1]?.messages ?? [];
    expect(mainMessages.some((message) => message.content.includes("旧问题、已完成操作和当前约束"))).toBe(true);
    expect(mainMessages.some((message) => message.content.includes("old user one"))).toBe(false);
    expect(mainMessages.at(-1)?.content).toContain("continue after compression");

    const persisted = harness.container.conversationStore.listMessages("runtime-compress-session", 20, 0, "root").items;
    const summary = persisted.find((message) => message.metadata.compression);
    expect(summary).toMatchObject({
      role: "assistant",
      metadata: expect.objectContaining({
        compression: true,
        replaces_up_to_seq: 4,
        compression_strategy: "llm_summarize",
      }),
    });

    const history = harness.container.events.getHistory("runtime-compress-session");
    expect(history.map((event) => event.type)).toEqual(
      expect.arrayContaining(["context.compression_start", "context.compression_summary", "context.usage"]),
    );
    expect(history.find((event) => event.type === "context.usage")?.data).toMatchObject({
      budget_tokens: 89,
      compression: {
        status: "success",
        replaced_message_count: 4,
        replaces_up_to_seq: 4,
      },
    });
  });

  it("publishes first-token and output chunk events when the chat client supports streaming", async () => {
    const chatClient = new FakeStreamingChatClient(["hello ", "from ", "stream"]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    disableDefaultAgentMemoryTools(harness);
    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-stream",
      },
      payload: {
        task: "stream hello",
        session_id: "runtime-stream-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("runtime-stream-session").task_info?.status === "completed",
    );

    expect(chatClient.requests).toHaveLength(1);
    const history = harness.container.events.getHistory("runtime-stream-session");
    const firstToken = history.find((event) => event.type === "llm.first_token");
    expect(firstToken?.data).toMatchObject({
      elapsed_ms: expect.any(Number),
      request_id: "req-runtime-stream",
    });
    expect(history.filter((event) => event.type === "llm.first_token")).toHaveLength(1);
    expect(history.filter((event) => event.type === "output.chunk").map((event) => event.data)).toEqual([
      expect.objectContaining({ content: "hello " }),
      expect.objectContaining({ content: "from " }),
      expect.objectContaining({ content: "stream" }),
    ]);
    expect(history.find((event) => event.type === "output.final_answer")?.data).toMatchObject({
      content: "hello from stream",
    });

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/runtime-stream-session/messages?expand=1",
    });
    expect(messages.json().data.items).toMatchObject([
      expect.objectContaining({ role: "user", content: "stream hello" }),
      expect.objectContaining({ role: "assistant", content: "hello from stream" }),
    ]);
  });

  it("executes memory tool calls during a minimal runtime-core run", async () => {
    const chatClient = new FakeToolCallingChatClient([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_memory_1",
            type: "function",
            function: {
              name: "list_memory_index",
              arguments: JSON.stringify({ scope: "session" }),
            },
          },
        ],
      },
      {
        content: "The session memory index is available.",
        finishReason: "stop",
      },
    ]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    writeTestMemoryFile(["memory", "sessions", "tool-runtime-session", "MEMORY.md"], "# Runtime Tool Memory\n");

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-tool",
      },
      payload: {
        task: "use memory",
        session_id: "tool-runtime-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("tool-runtime-session").task_info?.status === "completed",
    );

    expect(chatClient.requests).toHaveLength(2);
    expect(chatClient.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual([
      "request_user_input",
      "read_file",
      "write_file",
      "edit_file",
      "preview_data_structure",
      "execute_bash",
      "task_create",
      "task_get",
      "task_update",
      "task_list",
      "task_stop",
      "list_memory_index",
      "read_memory_entry",
      "write_memory",
      "archive_memory",
      "call_agent",
      "list_child_agents",
      "send_message",
    ]);
    expect(chatClient.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_memory_1",
          name: "list_memory_index",
          content: expect.stringContaining("# Runtime Tool Memory"),
        }),
      ]),
    );

    const history = harness.container.events.getHistory("tool-runtime-session");
    expect(history.filter((event) => event.type === "execution.step").map((event) => event.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          phase: "start",
          tool_name: "list_memory_index",
          call_id: "call_memory_1",
          tool_call_id: "call_memory_1",
          arguments: { scope: "session" },
        }),
        expect.objectContaining({
          kind: "tool",
          phase: "end",
          success: true,
          summary: "已读取 session MEMORY 索引",
        }),
      ]),
    );
    expect(history.find((event) => event.type === "output.final_answer")?.data).toMatchObject({
      content: "The session memory index is available.",
    });

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/tool-runtime-session/messages?expand=1",
    });
    expect(messages.json().data.items.at(-1)).toMatchObject({
      role: "assistant",
      content: "The session memory index is available.",
      execution_steps: expect.arrayContaining([
        expect.objectContaining({ kind: "tool", phase: "start" }),
        expect.objectContaining({ kind: "tool", phase: "end" }),
        expect.objectContaining({ kind: "final", phase: "complete" }),
      ]),
    });
  });

  it("pauses runtime tool execution for approval when permission policy asks", async () => {
    const chatClient = new FakeToolCallingChatClient([
      {
        content: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            id: "call_memory_approval",
            type: "function",
            function: {
              name: "list_memory_index",
              arguments: JSON.stringify({ scope: "session" }),
            },
          },
        ],
      },
      {
        content: "The approved memory index is available.",
        finishReason: "stop",
      },
    ]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    harness.container.permissionPolicy.setMode("strict");
    writeTestMemoryFile(["memory", "sessions", "approval-runtime-session", "MEMORY.md"], "# Approval Runtime Memory\n");

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-tool-approval",
      },
      payload: {
        task: "use memory with approval",
        session_id: "approval-runtime-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(() =>
      harness.container.events.getHistory("approval-runtime-session").some((event) => {
        const data = event.data as { kind?: string } | undefined;
        return event.type === "interaction.required" && data?.kind === "approval";
      }),
    );

    const approvalRequired = harness.container.events
      .getHistory("approval-runtime-session")
      .find((event) => {
        const data = event.data as { kind?: string } | undefined;
        return event.type === "interaction.required" && data?.kind === "approval";
      });
    expect(approvalRequired?.data).toMatchObject({
      approval_id: expect.any(String),
      tool_call_id: "call_memory_approval",
      tool_name: "list_memory_index",
      risk_level: "low",
      permission_mode: "strict",
      approval_reason: "严格模式：low 风险工具需要审批",
    });

    const approvalId = (approvalRequired?.data as { approval_id: string }).approval_id;
    const responded = await app.inject({
      method: "POST",
      url: `/api/agent/sessions/approval-runtime-session/interactions/${approvalId}/respond`,
      payload: {
        kind: "approval",
        approved: true,
        message: "允许读取",
      },
    });
    expect(responded.statusCode).toBe(200);

    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("approval-runtime-session").task_info?.status === "completed",
    );

    expect(chatClient.requests).toHaveLength(2);
    const history = harness.container.events.getHistory("approval-runtime-session");
    expect(history.filter((event) => event.type === "execution.step").map((event) => event.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          phase: "end",
          tool_name: "list_memory_index",
          success: true,
          approval_message: "允许读取",
          approval: expect.objectContaining({
            reason: "严格模式：low 风险工具需要审批",
            note: "允许读取",
            reason_codes: ["ask-risk"],
          }),
        }),
      ]),
    );
    expect(history.find((event) => event.type === "output.final_answer")?.data).toMatchObject({
      content: "The approved memory index is available.",
    });
  });

  it("publishes agent intent events for XML streaming tool runs", async () => {
    const chatClient = new FakeXmlStreamingToolChatClient([
      [
        "<intent>",
        "我先读取 session 记忆。",
        "</intent><tool_calls>",
        '<tool name="list_memory_index"><scope>session</scope></tool>',
        "</tool_calls>",
      ],
      ["<final_answer>", "The XML runtime read memory.", "</final_answer>"],
    ]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    writeTestMemoryFile(["memory", "sessions", "xml-tool-runtime-session", "MEMORY.md"], "# XML Runtime Memory\n");

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-xml-tool",
      },
      payload: {
        task: "use memory through xml",
        session_id: "xml-tool-runtime-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("xml-tool-runtime-session").task_info?.status === "completed",
    );

    expect(chatClient.requests).toHaveLength(2);
    expect(chatClient.requests[0]?.tools).toBeUndefined();
    expect(chatClient.requests[0]?.messages[0]?.content).toContain("<tool_manifest>");
    expect(chatClient.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("<tool_result"),
        }),
      ]),
    );

    const history = harness.container.events.getHistory("xml-tool-runtime-session");
    expect(history.find((event) => event.type === "agent.intent_delta")?.data).toMatchObject({
      content: "我先读取 session 记忆。",
      round: 0,
      request_id: "req-runtime-xml-tool",
    });
    expect(history.find((event) => event.type === "agent.intent_complete")?.data).toMatchObject({
      content: "我先读取 session 记忆。",
      round: 0,
    });
    expect(history.find((event) => event.type === "output.final_answer")?.data).toMatchObject({
      content: "The XML runtime read memory.",
    });

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/xml-tool-runtime-session/messages?expand=1",
    });
    expect(messages.json().data.items.at(-1)).toMatchObject({
      role: "assistant",
      content: "The XML runtime read memory.",
    });
  });

  it("injects completed background task notifications into the next run context", async () => {
    const chatClient = new FakeXmlStreamingToolChatClient([
      [
        "<tool_calls>",
        '<tool name="execute_bash">',
        '<command><![CDATA[node -e "setTimeout(function(){console.log(\'bg-notify\')}, 200)"]]></command>',
        "<run_in_background>true</run_in_background>",
        "<timeout>5</timeout>",
        "</tool>",
        "</tool_calls>",
      ],
      ["<final_answer>", "background started", "</final_answer>"],
      ["<final_answer>", "notification consumed", "</final_answer>"],
    ]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    harness.container.permissionPolicy.setMode("dangerously_skip_permissions");

    const first = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-bg-notify-1",
      },
      payload: {
        task: "start background task",
        session_id: "bg-notify-session",
      },
    });
    expect(first.statusCode).toBe(200);
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("bg-notify-session").task_info?.status === "completed",
      3000,
    );
    await waitFor(
      () => harness.container.events.getHistory("bg-notify-session").some((event) => event.type === "background.task.completed"),
      5000,
    );
    const completedEvent = harness.container.events
      .getHistory("bg-notify-session")
      .find((event) => event.type === "background.task.completed");
    const backgroundTaskId = (completedEvent?.data as { background_task_id?: string } | undefined)?.background_task_id;
    expect(backgroundTaskId).toEqual(expect.any(String));

    const second = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-bg-notify-2",
      },
      payload: {
        task: "continue after background task",
        session_id: "bg-notify-session",
      },
    });
    expect(second.statusCode).toBe(200);
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("bg-notify-session").task_info?.status === "completed",
      3000,
    );

    expect(chatClient.requests).toHaveLength(3);
    const secondRunNotification = chatClient.requests[2]?.messages.find(
      (message) => message.role === "user" && message.content.includes("<task-notification>"),
    );
    expect(secondRunNotification?.content).toContain(`<task-id>${backgroundTaskId}</task-id>`);
    expect(secondRunNotification?.content).toContain("<status>completed</status>");
    expect(secondRunNotification?.content).toContain("<result-type>bash_output</result-type>");
  });

  it("runs synchronous child agent delegation through XML tool calls", async () => {
    const chatClient = new FakeXmlStreamingToolChatClient([
      [
        "<intent>",
        "我让 plan_agent 先拆解迁移任务。",
        "</intent><tool_calls>",
        '<tool name="call_agent" id="delegate-plan"><agent_name>plan_agent</agent_name><task>拆解 TS 后端迁移下一步</task><context_hint>保持简洁，只输出关键步骤</context_hint></tool>',
        "</tool_calls>",
      ],
      ["<final_answer>", "child plan result", "</final_answer>"],
      ["<final_answer>", "parent final with child plan result", "</final_answer>"],
    ]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-delegate",
      },
      payload: {
        task: "需要规划迁移下一步",
        session_id: "delegate-runtime-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("delegate-runtime-session").task_info?.status === "completed",
      2000,
    );

    expect(chatClient.requests).toHaveLength(3);
    expect(chatClient.requests[0]?.agent?.agent_name).toBe("orchestrator_agent");
    expect(chatClient.requests[0]?.tools).toBeUndefined();
    expect(chatClient.requests[0]?.messages[0]?.content).toContain("call_agent");

    const childRequest = chatClient.requests[1];
    expect(childRequest?.agent?.agent_name).toBe("plan_agent");
    expect(childRequest?.messages.some((message) => message.content.includes("拆解 TS 后端迁移下一步"))).toBe(true);
    expect(childRequest?.messages.some((message) => message.content.includes("保持简洁，只输出关键步骤"))).toBe(true);

    const children = harness.container.conversationStore.listChildAgents({
      sessionId: "delegate-runtime-session",
      agentName: "plan_agent",
    });
    expect(children.total).toBe(1);
    const child = children.items[0]!;
    expect(child).toMatchObject({
      agent_name: "plan_agent",
      status: "active",
      thread_key: `child:${child.child_agent_id}`,
      created_by_call_id: expect.stringMatching(/^call_/),
      parent_call_id: "delegate-plan",
      last_run_id: expect.any(String),
      metadata: expect.objectContaining({
        created_via: "call_agent",
        thread_key: `child:${child.child_agent_id}`,
        uses_worktree: false,
      }),
    });

    const parentFinalRequest = chatClient.requests[2];
    const toolResultMessage = parentFinalRequest?.messages.find((message) =>
      message.role === "user" && message.content.includes("call_agent"),
    );
    expect(parentFinalRequest?.agent?.agent_name).toBe("orchestrator_agent");
    expect(toolResultMessage?.content).toContain("<tool_result");
    expect(toolResultMessage?.content).toContain(child.child_agent_id);
    expect(toolResultMessage?.content).toContain("child plan result");

    const childMessages = harness.container.conversationStore.listMessages(
      "delegate-runtime-session",
      20,
      0,
      child.thread_key,
    ).items;
    expect(childMessages).toMatchObject([
      {
        role: "user",
        content: expect.stringContaining("拆解 TS 后端迁移下一步"),
        child_agent_id: child.child_agent_id,
      },
      {
        role: "assistant",
        content: "child plan result",
        child_agent_id: child.child_agent_id,
      },
    ]);

    const history = harness.container.events.getHistory("delegate-runtime-session");
    const childAgentCalls = history.filter(
      (event) =>
        (event.type === "call.agent.start" || event.type === "call.agent.end") &&
        event.call_id === child.created_by_call_id,
    );
    expect(childAgentCalls).toEqual([
      expect.objectContaining({
        type: "call.agent.start",
        agent_name: "orchestrator_agent",
        call_id: child.created_by_call_id,
        parent_call_id: "delegate-plan",
        data: {
          agent_name: "plan_agent",
          description: "拆解 TS 后端迁移下一步",
          agent_display_name: "plan_agent",
          child_agent_id: child.child_agent_id,
          mode: "create",
        },
      }),
      expect.objectContaining({
        type: "call.agent.end",
        agent_name: "orchestrator_agent",
        call_id: child.created_by_call_id,
        parent_call_id: "delegate-plan",
        data: {
          agent_name: "plan_agent",
          result: "child plan result",
          success: true,
          agent_display_name: "plan_agent",
          child_agent_id: child.child_agent_id,
          mode: "create",
        },
      }),
    ]);
    expect(history.filter((event) => event.type === "execution.step").map((event) => event.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          phase: "start",
          tool_name: "call_agent",
          call_id: "delegate-plan",
          arguments: {
            agent_name: "plan_agent",
            task: "拆解 TS 后端迁移下一步",
            context_hint: "保持简洁，只输出关键步骤",
          },
        }),
        expect.objectContaining({
          kind: "tool",
          phase: "end",
          tool_name: "call_agent",
          success: true,
          summary: "child plan result",
        }),
      ]),
    );
    expect(history.find((event) => event.type === "output.final_answer")?.data).toMatchObject({
      content: "parent final with child plan result",
    });

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/delegate-runtime-session/messages?expand=1",
    });
    expect(messages.json().data.items.at(-1)).toMatchObject({
      role: "assistant",
      content: "parent final with child plan result",
    });
  });

  it("resumes an XML request_user_input tool call through the HTTP interaction response route", async () => {
    const chatClient = new FakeXmlStreamingToolChatClient([
      [
        "<intent>",
        "我需要确认记忆范围。",
        "</intent><tool_calls>",
        '<tool name="request_user_input"><prompt>使用哪个 memory scope？</prompt><input_type>select</input_type><options>["session","workspace"]</options></tool>',
        "</tool_calls>",
      ],
      ["<final_answer>", "已按 session memory 继续。", "</final_answer>"],
    ]);
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-input",
      },
      payload: {
        task: "需要时询问我",
        session_id: "input-runtime-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(() =>
      harness.container.events.getHistory("input-runtime-session").some((event) => event.type === "user.input_required"),
    );

    const inputRequired = harness.container.events
      .getHistory("input-runtime-session")
      .find((event) => event.type === "user.input_required");
    expect(inputRequired?.data).toMatchObject({
      input_id: expect.any(String),
      tool_call_id: "xml_round_0_call_1",
      tool_name: "request_user_input",
      prompt: "使用哪个 memory scope？",
      input_type: "select",
      options: ["session", "workspace"],
      run_id: started.json().data.run_id,
      request_id: "req-runtime-input",
    });

    const inputId = (inputRequired?.data as { input_id: string }).input_id;
    const responded = await app.inject({
      method: "POST",
      url: `/api/agent/sessions/input-runtime-session/interactions/${inputId}/respond`,
      payload: {
        kind: "user_input",
        value: "session",
      },
    });
    expect(responded.statusCode).toBe(200);
    expect(responded.json()).toMatchObject({
      success: true,
      data: {
        resolved: true,
        interaction_id: inputId,
        kind: "user_input",
      },
    });

    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("input-runtime-session").task_info?.status === "completed",
    );

    expect(chatClient.requests).toHaveLength(2);
    expect(chatClient.requests[0]?.messages[0]?.content).toContain("request_user_input");
    const toolResultMessage = chatClient.requests[1]?.messages.find((message) =>
      message.role === "user" && message.content.includes("request_user_input"),
    );
    expect(toolResultMessage?.content).toContain('semantic="user_input_response"');
    expect(toolResultMessage?.content).toContain("session");

    const history = harness.container.events.getHistory("input-runtime-session");
    expect(history.filter((event) => event.type === "execution.step").map((event) => event.data)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          phase: "start",
          tool_name: "request_user_input",
          call_id: "xml_round_0_call_1",
          arguments: {
            prompt: "使用哪个 memory scope？",
            input_type: "select",
            options: ["session", "workspace"],
          },
        }),
        expect.objectContaining({
          kind: "tool",
          phase: "end",
          tool_name: "request_user_input",
          success: true,
          summary: "用户输入已接收",
        }),
      ]),
    );
    expect(history.find((event) => event.type === "output.final_answer")?.data).toMatchObject({
      content: "已按 session memory 继续。",
    });
  });

  it("uses session team, entry agent, and workspace metadata when resolving runtime config", async () => {
    const chatClient = new FakeChatClient("team scoped answer");
    const harness = await buildTestHarness({ llmChatClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    harness.container.agentConfig.createTeam("research", "default");
    harness.container.agentConfig.activateTeam("research");
    harness.container.agentConfig.createAgent({
      agent_name: "research_agent",
      display_name: "Research Agent",
      default_entry: true,
      llm: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        extra_params: {},
      },
      custom_params: {
        behavior: {
          system_prompt: "You are research.",
        },
      },
    });
    harness.container.agentConfig.activateTeam("default");
    const workspaceRoot = path.resolve("runtime-workspace");
    harness.container.sessionApplication.createSession({
      sessionId: "team-runtime-session",
      metadata: {
        team: "research",
        entry_agent: "research_agent",
        workspace_root: workspaceRoot,
      },
    });

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-team-runtime",
      },
      payload: {
        task: "use session metadata",
        session_id: "team-runtime-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(() => harness.container.agentExecution.getSessionTaskStatus("team-runtime-session").task_info?.status === "completed");

    expect(chatClient.requests).toHaveLength(1);
    expect(chatClient.requests[0]).toMatchObject({
      agent: {
        agent_name: "research_agent",
        custom_params: expect.objectContaining({
          workspace_root: workspaceRoot,
        }),
      },
    });
    expect(chatClient.requests[0]?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("You are research."),
    });
    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/team-runtime-session/messages?expand=1",
    });
    expect(messages.json().data.items.at(-1)).toMatchObject({
      role: "assistant",
      content: "team scoped answer",
      metadata: {
        agent: "research_agent",
      },
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

    const history = harness.container.events.getHistory("interrupt-session");
    const userInterrupt = history.find((event) => event.type === "user.interrupt");
    expect(userInterrupt).toMatchObject({
      session_id: "interrupt-session",
      run_id: started.json().data.run_id,
      data: expect.objectContaining({
        reason: "user_stop",
        task_id: started.json().data.task_id,
        run_id: started.json().data.run_id,
        execution_kind: "agent_stream",
      }),
    });
    const rootCallStart = history.find((event) => event.type === "call.agent.start");
    expect(rootCallStart).toMatchObject({
      agent_name: "orchestrator_agent",
      call_id: expect.stringMatching(/^call_/),
    });
    expect(history.find((event) => event.type === "call.agent.end")).toMatchObject({
      agent_name: "orchestrator_agent",
      call_id: rootCallStart?.call_id,
      data: expect.objectContaining({
        agent_name: "orchestrator_agent",
        result: "[已停止生成]",
        success: false,
      }),
    });
    expect(history.find((event) => event.type === "agent.error")).toMatchObject({
      agent_name: "orchestrator_agent",
      call_id: rootCallStart?.call_id,
      data: expect.objectContaining({
        error_type: "InterruptedError",
      }),
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

function disableDefaultAgentMemoryTools(harness: Awaited<ReturnType<typeof buildTestHarness>>): void {
  const config = harness.container.agentConfig.getConfig("orchestrator_agent");
  expect(config).not.toBeNull();
  harness.container.agentConfig.replaceConfig("orchestrator_agent", {
    ...config!,
    memory: {
      ...config!.memory,
      allowed_scopes: [],
      write_scopes: [],
      archive_scopes: [],
    },
  });
}

function writeTestMemoryFile(parts: string[], content: string): void {
  const filePath = path.join(".test-data", ...parts);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
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
