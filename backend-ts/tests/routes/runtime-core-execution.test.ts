import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import type { Envelope } from "@ragsystem/agent-protocol";
import type {
  ChatToolCall,
  LlmClient,
  LlmRequest,
  LlmResult,
  LlmStreamHandler,
} from "@ragsystem/agent-llm";
import { EnvelopeProjector } from "../../src/services/runtime/event-outbox/projector.js";
import type { OutboxRow } from "../../src/contracts/conversation-store/types.js";
import { RuntimeAbortError } from "@ragsystem/agent-protocol";
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
  private resolver: (() => void) | null = null;

  constructor(private readonly content = "TS runtime answer") {}

  async complete(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    if (this.resolver) {
      await new Promise<void>((resolve) => {
        this.resolver = resolve;
      });
    }
    if (request.signal?.aborted) {
      throw new RuntimeAbortError("aborted");
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

class FailingChatClient implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly error = new Error("provider failed")) {}

  async complete(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    throw this.error;
  }
}

class FakeSequenceChatClient implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async complete(request: LlmRequest) {
    this.requests.push(request);
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("missing fake LLM response");
    }
    return { content };
  }
}

class FakeStreamingChatClient implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly chunks: string[]) {}

  async complete(): Promise<{ content: string }> {
    throw new Error("complete should not be called when stream is available");
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler) {
    this.requests.push(request);
    let content = "";
    for (const chunk of this.chunks) {
      content += chunk;
      if ((await onChunk({ content: chunk }))?.stop) {
        break;
      }
    }
    return { content };
  }
}

class FakeToolCallingChatClient implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly responses: LlmResult[]) {}

  async complete(request: LlmRequest) {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("missing fake LLM response");
    }
    return response;
  }
}

class FakeXmlStreamingToolChatClient implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly responses: string[][]) {}

  async complete(): Promise<{ content: string }> {
    throw new Error("complete should not be called for XML streaming tool loops");
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler) {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("missing fake XML stream response");
    }
    let content = "";
    for (const chunk of response) {
      content += chunk;
      if ((await onChunk({ content: chunk }))?.stop) {
        break;
      }
    }
    return { content, finishReason: "stop" };
  }
}

/**
 * Native（FC）混合协议 fake：每轮一组 chunk，chunk 可带 content（走 XML 解析）和/或
 * toolCalls（走厂商 FC 结构化）。content 必填（LlmStreamChunk.content 非可选），纯工具调用轮传 ""。
 */
class FakeNativeStreamingToolChatClient implements LlmClient {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly rounds: Array<Array<{ content: string; toolCalls?: ChatToolCall[] }>>) {}

  async complete(): Promise<LlmResult> {
    throw new Error("complete should not be called for native streaming");
  }

  async stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    this.requests.push(request);
    const round = this.rounds.shift();
    if (!round) {
      throw new Error("missing fake native stream round");
    }
    for (const chunk of round) {
      if ((await onChunk(chunk))?.stop) {
        break;
      }
    }
    return { content: "", finishReason: "stop" };
  }
}

describe("minimal runtime core execution", () => {
  it("starts a configured single-agent text run and persists the final answer", async () => {
    const chatClient = new FakeChatClient("hello from ts core");
    const harness = await buildTestHarness({ llmClient: chatClient });
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
    expect(messages.json().data.items).toEqual([
      expect.objectContaining({
        role: "user",
        content: "hello",
      }),
      expect.objectContaining({
        role: "assistant",
        content: "hello from ts core",
        has_execution: true,
        execution_steps: expect.arrayContaining([
          expect.objectContaining({
            kind: "final",
            phase: "complete",
            status: "completed",
            step_id: expect.stringMatching(/^call_.*:final$/),
            parent_step_id: expect.stringMatching(/^call_.*:run$/),
          }),
          expect.objectContaining({
            kind: "run",
            phase: "end",
            status: "completed",
            step_id: expect.stringMatching(/^call_.*:run$/),
            parent_step_id: null,
            result_preview: "hello from ts core",
          }),
        ]),
      }),
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

    const history = harness.container.realtimeEvents.getHistory("runtime-session");
    const eventTypes = history.map((event) => event.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "state_sync",
        "run_started",
        "agent_started",
        "agent_ended",
        "stream_output",
        "run_ended",
      ]),
    );
    const agentStart = history.find((event) => event.type === "agent_started");
    expect(agentStart).toMatchObject({
      agent_id: "orchestrator_agent",
      call_id: expect.stringMatching(/^call_/),
      payload: {
        phase: "start",
        task: "hello",
      },
    });
    const rootAgentCalls = history.filter(
      (event) =>
        (event.type === "agent_started" || event.type === "agent_ended") &&
        event.call_id === agentStart?.call_id,
    );
    expect(rootAgentCalls).toEqual([
      expect.objectContaining({
        type: "agent_started",
        agent_id: "orchestrator_agent",
        call_id: agentStart?.call_id,
        payload: expect.objectContaining({
          phase: "start",
          task: "hello",
        }),
      }),
      expect.objectContaining({
        type: "agent_ended",
        agent_id: "orchestrator_agent",
        call_id: agentStart?.call_id,
        payload: expect.objectContaining({
          phase: "end",
          result: "hello from ts core",
          success: true,
        }),
      }),
    ]);
    expect(
      history
        .filter((event) => event.type === "state_sync")
        .map((event) => event.payload as { category?: string; ref?: { message_id?: string; seq?: number; role?: string } })
        .filter((payload) => payload.category === "message_saved"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: expect.objectContaining({ message_id: expect.any(String), seq: expect.any(Number) }) }),
        expect.objectContaining({ ref: expect.objectContaining({ message_id: expect.any(String), seq: expect.any(Number) }) }),
      ]),
    );
    const finalStreamOutput = history.find(
      (event) =>
        event.type === "stream_output" &&
        (event.payload as { phase?: string }).phase === "final",
    );
    expect(finalStreamOutput?.payload).toMatchObject({
      phase: "final",
      content: "hello from ts core",
    });
    const contextUsage = history.find(
      (event) =>
        event.type === "state_sync" &&
        (event.payload as { category?: string }).category === "context_usage",
    );
    expect(contextUsage).toMatchObject({
      agent_id: "orchestrator_agent",
      payload: expect.objectContaining({
        category: "context_usage",
        detail: expect.objectContaining({
          used_tokens: expect.any(Number),
          system_prompt_tokens: expect.any(Number),
          total_tokens: expect.any(Number),
          budget_tokens: expect.any(Number),
          round: 0,
          compressing: false,
          request_id: "req-runtime-1",
        }),
      }),
    });
    expect(history.find((event) => event.type === "run_ended")?.payload).toMatchObject({
      status: "completed",
    });
    expectTerminalEventTypes(history, started.json().data.run_id).toEqual([
      "stream_output",
      "agent_ended",
      "run_ended",
    ]);
    const outboxRows = listRunOutbox(harness, "runtime-session", started.json().data.run_id);
    expect(outboxRows.map((row) => row.event_type)).toEqual([
      "client.run_started",
      "client.state_sync",
      "client.agent_started",
      "client.state_sync",
      "client.stream_output",
      "client.state_sync",
      "client.agent_ended",
      "client.run_ended",
    ]);
    expect(outboxRows.map((row) => row.status)).toEqual(Array.from({ length: outboxRows.length }, () => "delivered"));
    expect(harness.container.conversationStore.fetchPendingOutbox(10)).toEqual([]);
    expect(history.filter((event) => event.run_id === started.json().data.run_id).every((event) => event.seq !== undefined)).toBe(true);
    const terminalOutboxRows = filterTerminalOutboxRows(outboxRows);
    expect(terminalOutboxRows.map((row) => row.event_type)).toEqual([
      "client.stream_output",
      "client.agent_ended",
      "client.run_ended",
    ]);
    const terminalSeq = extractTerminalEvents(history, started.json().data.run_id).map((event) => event.seq);
    expect(terminalSeq).toHaveLength(3);
    expect(terminalSeq.every((seq) => typeof seq === "number" && seq > 1)).toBe(true);
    expect([...terminalSeq].sort((left, right) => Number(left) - Number(right))).toEqual(terminalSeq);
    expect(projectOutboxEventTypes(terminalOutboxRows)).toEqual([
      "stream_output",
      "agent_ended",
      "run_ended",
    ]);
  });

  it("compresses long session history before the main agent request", async () => {
    const chatClient = new FakeSequenceChatClient([
      "<analysis>draft</analysis><summary>旧问题、已完成操作和当前约束</summary>",
      "answer after compression",
    ]);
    const harness = await buildTestHarness({ llmClient: chatClient });
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

    const history = harness.container.realtimeEvents.getHistory("runtime-compress-session");
    const compressionStateSyncs = history.filter(
      (event) => event.type === "state_sync" && (event.payload as { category?: string }).category === "compression",
    );
    // compression_start + compression_summary 各一条（context-compression 发两类事件，经
    // event-publisher 投影为 state_sync(compression)，detail 透传原 event.data）。
    expect(compressionStateSyncs).toHaveLength(2);
    expect(compressionStateSyncs.map((event) => (event.payload as { detail?: { has_existing_summary?: boolean } }).detail?.has_existing_summary)).toEqual(
      expect.arrayContaining([expect.any(Boolean), undefined]),
    );
    expect(compressionStateSyncs.map((event) => (event.payload as { detail?: { status?: string } }).detail?.status)).toEqual(
      expect.arrayContaining([undefined, "success"]),
    );
    // 压缩已下沉到内核 beforeModel hook（round 0 触发）：run 起始的 context_usage 不再内嵌
    // compression 块；压缩行为由上面的 state_sync(compression) 事件与持久化摘要消息体现。
    const contextUsage = history.find(
      (event) => event.type === "state_sync" && (event.payload as { category?: string }).category === "context_usage",
    );
    expect((contextUsage?.payload as { detail?: { budget_tokens?: number } }).detail).toMatchObject({
      budget_tokens: 89,
    });
  });

  it("publishes first-token and output chunk events when the chat client supports streaming", async () => {
    const chatClient = new FakeStreamingChatClient(["hello ", "from ", "stream"]);
    const harness = await buildTestHarness({ llmClient: chatClient });
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
    const history = harness.container.realtimeEvents.getHistory("runtime-stream-session");
    const firstToken = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "first_token",
    );
    expect(firstToken?.payload).toMatchObject({
      phase: "first_token",
      elapsed_ms: expect.any(Number),
    });
    expect(
      history.filter(
        (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "first_token",
      ),
    ).toHaveLength(1);
    expect(
      history
        .filter(
          (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "delta",
        )
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({ phase: "delta", content: "hello " }),
      expect.objectContaining({ phase: "delta", content: "from " }),
      expect.objectContaining({ phase: "delta", content: "stream" }),
    ]);
    const finalAnswer = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "final",
    );
    expect(finalAnswer?.payload).toMatchObject({
      phase: "final",
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

  it("injects validated session attachments into the runtime user message", async () => {
    const chatClient = new FakeChatClient("attachment answer");
    const harness = await buildTestHarness({ llmClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    const upload = await app.inject({
      method: "POST",
      url: "/api/agent/sessions/attachment-runtime-session/files/upload",
      headers: multipartHeaders("boundary-attachment-runtime"),
      payload: multipartBody("boundary-attachment-runtime", "files", "alpha.txt", "text/plain", "alpha attachment"),
    });
    expect(upload.statusCode).toBe(200);
    const fileId = upload.json().files[0].id;

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-attachment-runtime",
      },
      payload: {
        task: "summarize attachment",
        session_id: "attachment-runtime-session",
        attachments: [{ file_id: fileId }],
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(() =>
      harness.container.agentExecution.getSessionTaskStatus("attachment-runtime-session").task_info?.status === "completed",
    );

    const userContents = chatClient.requests[0]?.messages
      .filter((message) => message.role === "user")
      .map((message) => message.content) ?? [];
    expect(userContents).toEqual(
      expect.arrayContaining([
        expect.stringContaining("<attachments>"),
        expect.stringContaining(`file_id="${fileId}"`),
        expect.stringContaining("alpha.txt"),
      ]),
    );
    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/attachment-runtime-session/messages",
    });
    // 持久化 content 为用户原文；附件清单仅注入 LLM、不落库
    expect(messages.json().data.items[0]).toMatchObject({
      role: "user",
      content: "summarize attachment",
      metadata: {
        attachments: [
          expect.objectContaining({
            file_id: fileId,
            original_name: "alpha.txt",
          }),
        ],
      },
    });
  });

  it("expands prompt slash commands before starting the runtime", async () => {
    const chatClient = new FakeChatClient("review answer");
    const harness = await buildTestHarness({ llmClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: {
        task: "/review src/services",
        session_id: "slash-review-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(() => harness.container.agentExecution.getSessionTaskStatus("slash-review-session").task_info?.status === "completed");

    const promptContents = chatClient.requests[0]?.messages.map((message) => message.content) ?? [];
    expect(promptContents).toEqual(
      expect.arrayContaining([
        expect.stringContaining("请对以下内容进行全面的代码审查"),
        expect.stringContaining("src/services"),
      ]),
    );
    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/slash-review-session/messages",
    });
    expect(messages.json().data.items[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("请对以下内容进行全面的代码审查"),
      metadata: {
        type: "command",
        command: "review",
      },
    });
  });

  it("handles system slash help without starting an agent run", async () => {
    const chatClient = new FakeChatClient("should not run");
    const harness = await buildTestHarness({ llmClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: {
        task: "/help",
        session_id: "slash-help-session",
      },
    });

    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      success: true,
      data: {
        started: true,
        session_id: "slash-help-session",
        kind: "command",
      },
    });
    expect(chatClient.requests).toHaveLength(0);
    expect(harness.container.realtimeEvents.getHistory("slash-help-session")).toEqual([
      expect.objectContaining({
        type: "state_sync",
        payload: expect.objectContaining({
          category: "command_result",
          detail: expect.objectContaining({
            command: "help",
            success: true,
            content: expect.stringContaining("/review"),
          }),
        }),
      }),
    ]);
    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/slash-help-session/messages",
    });
    expect(messages.json().data.items).toMatchObject([
      expect.objectContaining({
        role: "user",
        content: "/help",
        metadata: expect.objectContaining({ type: "command", command: "help" }),
      }),
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("可用命令"),
        metadata: expect.objectContaining({ type: "command_result", command: "help", success: true }),
      }),
    ]);
  });

  it("handles system slash compact by forcing context compression without starting an agent run", async () => {
    const chatClient = new FakeChatClient("<analysis>draft</analysis><summary>旧问题、已完成操作和当前约束</summary>");
    const harness = await buildTestHarness({ llmClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);
    const config = harness.container.agentConfig.getConfig("orchestrator_agent");
    if (!config) {
      throw new Error("orchestrator_agent config missing");
    }
    const behavior = asRecord(config.custom_params.behavior);
    harness.container.agentConfig.replaceConfig("orchestrator_agent", {
      ...config,
      custom_params: {
        ...config.custom_params,
        behavior: {
          ...behavior,
          preserve_recent_turns: 1,
          summarize_max_tokens: 64,
        },
      },
      memory: {
        ...config.memory,
        allowed_scopes: [],
        write_scopes: [],
        archive_scopes: [],
      },
    });
    harness.container.sessionApplication.createSession({ sessionId: "slash-compact-session" });
    for (const [role, content] of [
      ["user", "old user one"],
      ["assistant", "old assistant one"],
      ["user", "tail user"],
      ["assistant", "tail assistant"],
    ] as const) {
      harness.container.sessionApplication.addMessage({
        sessionId: "slash-compact-session",
        role,
        content,
      });
    }

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: { "x-request-id": "req-slash-compact" },
      payload: {
        task: "/compact",
        session_id: "slash-compact-session",
      },
    });

    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      success: true,
      data: {
        started: true,
        session_id: "slash-compact-session",
        kind: "command",
      },
    });
    expect(harness.container.agentExecution.getSessionTaskStatus("slash-compact-session").has_running_task).toBe(false);
    expect(chatClient.requests).toHaveLength(1);
    expect(chatClient.requests[0]?.messages[0]?.content).toContain("对话摘要助手");

    const history = harness.container.realtimeEvents.getHistory("slash-compact-session");
    const categories = history
      .filter((event) => event.type === "state_sync")
      .map((event) => (event.payload as { category?: string }).category);
    expect(categories).toEqual(
      expect.arrayContaining(["compression", "command_result"]),
    );
    const commandResult = history.find(
      (event) =>
        event.type === "state_sync" && (event.payload as { category?: string }).category === "command_result",
    );
    expect(commandResult).toMatchObject({
      type: "state_sync",
      payload: expect.objectContaining({
        category: "command_result",
        detail: expect.objectContaining({
          command: "compact",
          success: true,
          content: expect.stringContaining("压缩完成"),
          data: expect.objectContaining({
            status: "success",
            reason: "success",
          }),
        }),
      }),
    });

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/slash-compact-session/messages",
    });
    expect(messages.json().data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("旧问题、已完成操作和当前约束"),
          metadata: expect.objectContaining({
            compression: true,
            forced: true,
          }),
        }),
        expect.objectContaining({
          role: "system",
          content: expect.stringContaining("压缩完成"),
          metadata: expect.objectContaining({ type: "command_result", command: "compact", success: true }),
        }),
      ]),
    );
  });

  it("skips system slash compact when history has nothing to compress", async () => {
    const chatClient = new FakeChatClient("should not run");
    const harness = await buildTestHarness({ llmClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      payload: {
        task: "/compact",
        session_id: "slash-compact-skip-session",
      },
    });

    expect(started.statusCode).toBe(200);
    expect(chatClient.requests).toHaveLength(0);
    expect(harness.container.realtimeEvents.getHistory("slash-compact-skip-session")).toEqual([
      expect.objectContaining({
        type: "state_sync",
        payload: expect.objectContaining({
          category: "command_result",
          detail: expect.objectContaining({
            command: "compact",
            success: true,
            content: "无需压缩（历史为空或消息不足）",
            data: expect.objectContaining({
              status: "skipped",
              reason: "insufficient_candidates",
            }),
          }),
        }),
      }),
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
    const harness = await buildTestHarness({ llmClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app, { supportsFunctionCalling: true });
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
      "execute_code",
      "glob",
      "grep",
      "web_fetch",
      "todo_write",
      "task_create",
      "task_get",
      "task_update",
      "task_list",
      "task_output",
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

    const history = harness.container.realtimeEvents.getHistory("tool-runtime-session");
    const toolCalls = history.filter((event) => event.type === "tool_call");
    const toolResults = history.filter((event) => event.type === "tool_result");
    expect(toolCalls.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "list_memory_index",
          mode: "projection",
          phase: "start",
          status: "running",
          input: { scope: "session" },
        }),
      ]),
    );
    expect(history.find((event) => event.type === "tool_call")?.call_id).toEqual("call_memory_1");
    expect(toolResults.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "list_memory_index",
          mode: "projection",
          phase: "end",
          ok: true,
          status: "succeeded",
          summary: "已读取 session MEMORY 索引",
        }),
      ]),
    );
    const finalAnswer = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "final",
    );
    expect(finalAnswer?.payload).toMatchObject({
      phase: "final",
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
        expect.objectContaining({
          kind: "tool",
          phase: "start",
          tool_name: "list_memory_index",
          step_id: "call_memory_1:tool",
          parent_step_id: expect.stringMatching(/^call_.*:round:0$/),
          status: "running",
        }),
        expect.objectContaining({
          kind: "tool",
          phase: "end",
          tool_name: "list_memory_index",
          step_id: "call_memory_1:tool",
          parent_step_id: expect.stringMatching(/^call_.*:round:0$/),
          status: "success",
        }),
        expect.objectContaining({ kind: "final", phase: "complete", status: "completed" }),
        expect.objectContaining({ kind: "run", phase: "end", status: "completed" }),
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
    const harness = await buildTestHarness({ llmClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app, { supportsFunctionCalling: true });
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
      harness.container.realtimeEvents.getHistory("approval-runtime-session").some((event) => {
        const payload = event.payload as { kind?: string; phase?: string };
        return event.type === "interaction" && payload?.kind === "approval" && payload?.phase === "required";
      }),
    );

    const approvalRequired = harness.container.realtimeEvents
      .getHistory("approval-runtime-session")
      .find((event) => {
        const payload = event.payload as { kind?: string; phase?: string };
        return event.type === "interaction" && payload?.kind === "approval" && payload?.phase === "required";
      });
    expect(approvalRequired).toMatchObject({
      type: "interaction",
      call_id: expect.any(String),
      payload: expect.objectContaining({
        kind: "approval",
        phase: "required",
        tool: "list_memory_index",
        risk_level: "low",
        message: "严格模式：low 风险工具需要审批",
        input: expect.objectContaining({
          approval_id: expect.any(String),
          tool_call_id: "call_memory_approval",
          permission_mode: "strict",
          approval_reason: "严格模式：low 风险工具需要审批",
        }),
      }),
    });

    const approvalId = approvalRequired?.call_id;
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
    const history = harness.container.realtimeEvents.getHistory("approval-runtime-session");
    // 审批通过语义在新协议下由 interaction(approval, responded) 事件承载（tool_result 不再内嵌
    // approval 元数据——新 envelope 的 approval 字段仅在 status=pending/granted/denied 时产出）。
    expect(history.filter((event) => event.type === "tool_result").map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "list_memory_index",
          phase: "end",
          ok: true,
          status: "succeeded",
        }),
      ]),
    );
    const approvalResponded = history.find(
      (event) =>
        event.type === "interaction" &&
        (event.payload as { kind?: string; phase?: string }).kind === "approval" &&
        (event.payload as { phase?: string }).phase === "responded",
    );
    expect(approvalResponded?.call_id).toBe(approvalId);
    expect(approvalResponded?.payload).toMatchObject({
      kind: "approval",
      phase: "responded",
      approved: true,
      message: "允许读取",
    });
    const approvalFinalAnswer = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "final",
    );
    expect(approvalFinalAnswer?.payload).toMatchObject({
      phase: "final",
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
    const harness = await buildTestHarness({ llmClient: chatClient });
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

    const history = harness.container.realtimeEvents.getHistory("xml-tool-runtime-session");
    const intentDelta = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "intent_delta",
    );
    expect(intentDelta?.payload).toMatchObject({
      phase: "intent_delta",
      content: "我先读取 session 记忆。",
      round: 0,
    });
    const intentComplete = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "intent_complete",
    );
    expect(intentComplete?.payload).toMatchObject({
      phase: "intent_complete",
      content: "我先读取 session 记忆。",
      round: 0,
    });
    const finalAnswer = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "final",
    );
    expect(finalAnswer?.payload).toMatchObject({
      phase: "final",
      content: "The XML runtime read memory.",
    });

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/xml-tool-runtime-session/messages?expand=1",
    });
    expect(messages.json().data.items).toHaveLength(2);
    expect(messages.json().data.items.at(-1)).toMatchObject({
      role: "assistant",
      content: "The XML runtime read memory.",
    });

    const rawMessages = harness.container.conversationStore.listMessages("xml-tool-runtime-session", 20, 0, "root").items;
    expect(rawMessages).toHaveLength(4);
    expect(rawMessages.map((message) => [message.role, message.metadata.react_intermediate ?? false, message.metadata.msg_type ?? null])).toEqual([
      ["user", false, null],
      ["assistant", true, "intent"],
      ["tool", true, "observation"],
      ["assistant", false, "assistant_final"],
    ]);

    const intent = rawMessages[1]!;
    expect(intent.content).toContain("我先读取 session 记忆。");
    expect(intent.tool_calls).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "list_memory_index",
          arguments: expect.stringContaining("session"),
        }),
      }),
    ]);
    expect(intent.metadata).toMatchObject({
      react_intermediate: true,
      msg_type: "intent",
      round: 1,
      run_id: started.json().data.run_id,
      request_id: "req-runtime-xml-tool",
      agent: "orchestrator_agent",
      thread_key: "root",
      conversation_scope: "root",
      visible_to_user: true,
      execution_kind: "agent_stream",
    });

    const observation = rawMessages[2]!;
    expect(observation.content).toContain("<tool_result");
    expect(observation.content).toContain("# XML Runtime Memory");
    expect(observation.metadata).toMatchObject({
      react_intermediate: true,
      msg_type: "observation",
      round: 1,
      run_id: started.json().data.run_id,
      request_id: "req-runtime-xml-tool",
      agent: "orchestrator_agent",
      thread_key: "root",
      conversation_scope: "root",
      visible_to_user: true,
      execution_kind: "agent_stream",
    });

    const snapshot = await app.inject({
      method: "GET",
      url: "/api/agent/context-snapshot?session_id=xml-tool-runtime-session",
    });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().data.conversation_history).toEqual([
      expect.objectContaining({ role: "user", content_preview: expect.stringContaining("use memory through xml") }),
      expect.objectContaining({
        seq: intent.seq,
        role: "assistant",
        react_intermediate: true,
        msg_type: "intent",
        round: 1,
        content_preview: expect.stringContaining(intent.content),
      }),
      expect.objectContaining({
        seq: observation.seq,
        role: "user",
        react_intermediate: true,
        msg_type: "observation",
        round: 1,
        content_preview: expect.stringContaining("<tool_result"),
      }),
      expect.objectContaining({
        role: "assistant",
        content_preview: expect.stringContaining("The XML runtime read memory."),
      }),
    ]);
  });

  it("publishes agent intent events for native FC + XML content streaming tool runs", async () => {
    const chatClient = new FakeNativeStreamingToolChatClient([
      [
        { content: "<intent>" },
        { content: "我先读取 session 记忆。" },
        { content: "</intent>" },
        {
          content: "",
          toolCalls: [
            { id: "call_native_1", type: "function", function: { name: "list_memory_index", arguments: '{"scope":"session"}' } },
          ],
        },
      ],
      [
        { content: "<final_answer>" },
        { content: "The native runtime read memory." },
        { content: "</final_answer>" },
      ],
    ]);
    const harness = await buildTestHarness({ llmClient: chatClient });
    app = harness.app;

    await createDefaultChatProvider(app, { supportsFunctionCalling: true });
    writeTestMemoryFile(["memory", "sessions", "native-tool-runtime-session", "MEMORY.md"], "# Native Runtime Memory\n");

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-native-tool",
      },
      payload: {
        task: "use memory through native fc",
        session_id: "native-tool-runtime-session",
      },
    });

    expect(started.statusCode).toBe(200);
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("native-tool-runtime-session").task_info?.status === "completed",
    );

    expect(chatClient.requests).toHaveLength(2);
    // native 特征：带 tools + toolChoice:auto；混合协议说明无 tool_manifest（工具走 FC）
    expect(chatClient.requests[0]?.toolChoice).toBe("auto");
    expect(chatClient.requests[0]?.tools).toBeDefined();
    expect(chatClient.requests[0]?.messages[0]?.content).not.toContain("<tool_manifest>");
    // native 提示词不引入 <tool_calls> 概念（工具走 FC）
    expect(chatClient.requests[0]?.messages[0]?.content).not.toContain("<tool_calls>");
    // observation 回填为 native 结构化 role:tool（content 仍含 <tool_result>，因 observation 字段已是该格式）
    expect(chatClient.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_native_1",
          name: "list_memory_index",
        }),
      ]),
    );

    const history = harness.container.realtimeEvents.getHistory("native-tool-runtime-session");
    const intentDelta = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "intent_delta",
    );
    expect(intentDelta?.payload).toMatchObject({
      phase: "intent_delta",
      content: "我先读取 session 记忆。",
      round: 0,
    });
    const intentComplete = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "intent_complete",
    );
    expect(intentComplete?.payload).toMatchObject({
      phase: "intent_complete",
      content: "我先读取 session 记忆。",
      round: 0,
    });
    const finalAnswer = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "final",
    );
    expect(finalAnswer?.payload).toMatchObject({
      phase: "final",
      content: "The native runtime read memory.",
    });

    const messages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/native-tool-runtime-session/messages?expand=1",
    });
    expect(messages.json().data.items).toHaveLength(2);
    expect(messages.json().data.items.at(-1)).toMatchObject({
      role: "assistant",
      content: "The native runtime read memory.",
    });

    const rawMessages = harness.container.conversationStore.listMessages("native-tool-runtime-session", 20, 0, "root").items;
    expect(rawMessages).toHaveLength(4);
    expect(rawMessages.map((message) => [message.role, message.metadata.react_intermediate ?? false, message.metadata.msg_type ?? null])).toEqual([
      ["user", false, null],
      ["assistant", true, "intent"],
      ["tool", true, "observation"],
      ["assistant", false, "assistant_final"],
    ]);

    const intent = rawMessages[1]!;
    expect(intent.content).toContain("我先读取 session 记忆。");
    expect(intent.tool_calls).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({
          name: "list_memory_index",
          arguments: expect.stringContaining("session"),
        }),
      }),
    ]);
    expect(intent.metadata).toMatchObject({
      react_intermediate: true,
      msg_type: "intent",
      round: 1,
      run_id: started.json().data.run_id,
      request_id: "req-runtime-native-tool",
      agent: "orchestrator_agent",
      thread_key: "root",
      conversation_scope: "root",
      visible_to_user: true,
      execution_kind: "agent_stream",
    });

    const observation = rawMessages[2]!;
    expect(observation.content).toContain("<tool_result");
    expect(observation.content).toContain("# Native Runtime Memory");
    expect(observation.metadata).toMatchObject({
      react_intermediate: true,
      msg_type: "observation",
      round: 1,
      run_id: started.json().data.run_id,
      request_id: "req-runtime-native-tool",
      agent: "orchestrator_agent",
      thread_key: "root",
      conversation_scope: "root",
      visible_to_user: true,
      execution_kind: "agent_stream",
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
    const harness = await buildTestHarness({ llmClient: chatClient });
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
    const firstRunId = first.json().data.run_id;
    await waitFor(
      () => harness.container.agentExecution.getSessionTaskStatus("bg-notify-session").task_info?.status === "completed",
      3000,
    );
    await waitFor(
      () =>
        harness.container.realtimeEvents
          .getHistory("bg-notify-session")
          .some(
            (event) =>
              event.type === "state_sync" &&
              (event.payload as { category?: string; detail?: { kind?: string } }).category === "command_result" &&
              (event.payload as { detail?: { kind?: string } }).detail?.kind === "background_task",
          ),
      5000,
    );
    const completedEvent = harness.container.realtimeEvents
      .getHistory("bg-notify-session")
      .find(
        (event) =>
          event.type === "state_sync" &&
          (event.payload as { category?: string }).category === "command_result" &&
          (event.payload as { detail?: { kind?: string } }).detail?.kind === "background_task",
      );
    const backgroundTaskId = (completedEvent?.payload as { detail?: { background_task_id?: string } } | undefined)?.detail
      ?.background_task_id;
    expect(backgroundTaskId).toEqual(expect.any(String));
    expect(completedEvent).toMatchObject({
      seq: expect.any(Number),
    });
    expect(
      listRunOutbox(harness, "bg-notify-session", firstRunId)
        .filter((row) => row.event_type === "client.state_sync")
        .filter((row) => {
          const payload = JSON.parse(row.payload) as { client_event?: { payload?: { category?: string; detail?: { kind?: string } } } };
          return (
            payload.client_event?.payload?.category === "command_result" &&
            payload.client_event?.payload?.detail?.kind === "background_task"
          );
        })
        .map((row) => ({
          status: row.status,
          sessionSeq: row.session_seq,
        })),
    ).toEqual([
      {
        status: "delivered",
        sessionSeq: completedEvent?.seq,
      },
    ]);

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
    const harness = await buildTestHarness({ llmClient: chatClient });
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
    expect(chatClient.requests[0]?.tools).toBeUndefined();
    expect(chatClient.requests[0]?.messages[0]?.content).toContain("call_agent");

    const childRequest = chatClient.requests[1];
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

    const history = harness.container.realtimeEvents.getHistory("delegate-runtime-session");
    const childAgentCalls = history.filter(
      (event) =>
        (event.type === "agent_started" || event.type === "agent_ended") &&
        event.call_id === child.created_by_call_id,
    );
    // 委派 publishAgentCallStart/End 独占发 child agent_started/ended（单发）；
    // lineage.parent_call_id 挂 root agent（orchestrator）的 call_id，core execution-tree 据此嵌套。
    const rootAgentCallId = history.find(
      (event) =>
        event.type === "agent_started" &&
        !((event.payload as { lineage?: { parent_call_id?: string } }).lineage?.parent_call_id),
    )?.call_id;
    expect(childAgentCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent_started",
          agent_id: "plan_agent",
          call_id: child.created_by_call_id,
          payload: expect.objectContaining({
            phase: "start",
            task: "拆解 TS 后端迁移下一步",
            lineage: { parent_call_id: rootAgentCallId },
          }),
        }),
        expect.objectContaining({
          type: "agent_ended",
          agent_id: "plan_agent",
          call_id: child.created_by_call_id,
          payload: expect.objectContaining({
            phase: "end",
            result: "child plan result",
            success: true,
            lineage: { parent_call_id: rootAgentCallId },
          }),
        }),
      ]),
    );
    expect(history.filter((event) => event.type === "tool_call").map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "call_agent",
          phase: "start",
          mode: "projection",
          input: {
            agent_name: "plan_agent",
            task: "拆解 TS 后端迁移下一步",
            context_hint: "保持简洁，只输出关键步骤",
          },
        }),
      ]),
    );
    expect(history.find((event) => event.type === "tool_call" && (event.payload as { tool?: string }).tool === "call_agent")?.call_id).toBe("delegate-plan");
    expect(history.filter((event) => event.type === "tool_result").map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "call_agent",
          phase: "end",
          ok: true,
          summary: "child plan result",
        }),
      ]),
    );
    const finalAnswer = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "final",
    );
    expect(finalAnswer?.payload).toMatchObject({
      phase: "final",
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
    const harness = await buildTestHarness({ llmClient: chatClient });
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
      harness.container.realtimeEvents.getHistory("input-runtime-session").some((event) => {
        const payload = event.payload as { kind?: string; phase?: string };
        return event.type === "interaction" && payload?.kind === "user_input" && payload?.phase === "required";
      }),
    );

    const inputRequired = harness.container.realtimeEvents
      .getHistory("input-runtime-session")
      .find((event) => {
        const payload = event.payload as { kind?: string; phase?: string };
        return event.type === "interaction" && payload?.kind === "user_input" && payload?.phase === "required";
      });
    expect(inputRequired).toMatchObject({
      type: "interaction",
      call_id: expect.any(String),
      run_id: started.json().data.run_id,
      payload: expect.objectContaining({
        kind: "user_input",
        phase: "required",
        tool: "request_user_input",
        prompt: "使用哪个 memory scope？",
        input: expect.objectContaining({
          input_type: "select",
          options: ["session", "workspace"],
          tool_call_id: "xml_round_0_call_1",
        }),
      }),
    });

    const inputId = inputRequired?.call_id;
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

    const history = harness.container.realtimeEvents.getHistory("input-runtime-session");
    expect(history.filter((event) => event.type === "tool_call").map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "request_user_input",
          phase: "start",
          mode: "projection",
          input: {
            prompt: "使用哪个 memory scope？",
            input_type: "select",
            options: ["session", "workspace"],
          },
        }),
      ]),
    );
    expect(history.find((event) => event.type === "tool_call" && (event.payload as { tool?: string }).tool === "request_user_input")?.call_id).toBe("xml_round_0_call_1");
    expect(history.filter((event) => event.type === "tool_result").map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "request_user_input",
          phase: "end",
          ok: true,
          summary: "用户输入已接收",
        }),
      ]),
    );
    const finalAnswer = history.find(
      (event) => event.type === "stream_output" && (event.payload as { phase?: string }).phase === "final",
    );
    expect(finalAnswer?.payload).toMatchObject({
      phase: "final",
      content: "已按 session memory 继续。",
    });
  });

  it("uses session team, entry agent, and workspace metadata when resolving runtime config", async () => {
    const chatClient = new FakeChatClient("team scoped answer");
    const harness = await buildTestHarness({ llmClient: chatClient });
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
    const harness = await buildTestHarness({ llmClient: chatClient });
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

    const history = harness.container.realtimeEvents.getHistory("interrupt-session");
    const userInterrupt = history.find((event) => event.type === "abort");
    expect(userInterrupt).toMatchObject({
      session_id: "interrupt-session",
      run_id: started.json().data.run_id,
      payload: expect.objectContaining({
        scope: "run",
        reason: "user_stop",
      }),
    });
    const rootCallStart = history.find((event) => event.type === "agent_started");
    expect(rootCallStart).toMatchObject({
      agent_id: "orchestrator_agent",
      call_id: expect.stringMatching(/^call_/),
    });
    expect(history.find((event) => event.type === "agent_ended")).toMatchObject({
      agent_id: "orchestrator_agent",
      call_id: rootCallStart?.call_id,
      payload: expect.objectContaining({
        phase: "end",
        result: "[已停止生成]",
        success: false,
      }),
    });
    expect(history.find((event) => event.type === "run_ended")).toMatchObject({
      run_id: started.json().data.run_id,
      payload: expect.objectContaining({
        status: "interrupted",
      }),
    });
    expectTerminalEventTypes(history, started.json().data.run_id).toEqual([
      "abort",
      "agent_ended",
      "run_ended",
    ]);
    const outboxRows = listRunOutbox(harness, "interrupt-session", started.json().data.run_id);
    expect(outboxRows.map((row) => row.event_type)).toEqual([
      "client.run_started",
      "client.state_sync",
      "client.agent_started",
      "client.state_sync",
      "client.abort",
      "client.agent_ended",
      "client.run_ended",
    ]);
    const terminalOutboxRows = filterTerminalOutboxRows(outboxRows);
    expect(terminalOutboxRows.map((row) => row.event_type)).toEqual([
      "client.abort",
      "client.agent_ended",
      "client.run_ended",
    ]);
    expect(outboxRows.map((row) => row.status)).toEqual(Array.from({ length: outboxRows.length }, () => "delivered"));
    expect(harness.container.conversationStore.fetchPendingOutbox(10)).toEqual([]);
    expect(projectOutboxEventTypes(terminalOutboxRows)).toEqual([
      "abort",
      "agent_ended",
      "run_ended",
    ]);

    // 打断后落库 interrupted assistant 锚点消息：刷新后承载工具调用步骤 + 恢复"已停止生成"
    const interruptedMessages = await app.inject({
      method: "GET",
      url: "/api/agent/sessions/interrupt-session/messages",
    });
    const interruptedAssistant = interruptedMessages.json().data.items.filter((m: { role?: string }) => m.role === "assistant");
    expect(interruptedAssistant).toHaveLength(1);
    expect(interruptedAssistant[0]).toMatchObject({
      role: "assistant",
      content: "",
      metadata: expect.objectContaining({ interrupted: true }),
    });
  });

  it("publishes the failed terminal event sequence when the provider fails", async () => {
    const chatClient = new FailingChatClient(new Error("provider failed"));
    const logEntries: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    const harness = await buildTestHarness({
      llmClient: chatClient,
      logger: {
        error: (bindings, message) => {
          logEntries.push({ bindings, message });
        },
      },
    });
    app = harness.app;

    await createDefaultChatProvider(app);

    const started = await app.inject({
      method: "POST",
      url: "/api/agent/stream",
      headers: {
        "x-request-id": "req-runtime-failed",
      },
      payload: {
        task: "fail task",
        session_id: "failed-runtime-session",
      },
    });
    expect(started.statusCode).toBe(200);

    await waitFor(() => harness.container.agentExecution.getSessionTaskStatus("failed-runtime-session").task_info?.status === "failed");

    expect(chatClient.requests).toHaveLength(1);
    const history = harness.container.realtimeEvents.getHistory("failed-runtime-session");
    const rootCallStart = history.find((event) => event.type === "agent_started");
    expect(rootCallStart).toMatchObject({
      agent_id: "orchestrator_agent",
      call_id: expect.stringMatching(/^call_/),
    });
    expect(history.find((event) => event.type === "agent_ended")).toMatchObject({
      agent_id: "orchestrator_agent",
      call_id: rootCallStart?.call_id,
      payload: expect.objectContaining({
        phase: "end",
        result: "provider failed",
        success: false,
      }),
    });
    const errorEvent = history.find((event) => event.type === "error");
    expect(errorEvent).toMatchObject({
      agent_id: "orchestrator_agent",
      call_id: rootCallStart?.call_id,
      payload: expect.objectContaining({
        code: "RuntimeError",
        message: "provider failed",
      }),
    });
    expect(history.find((event) => event.type === "run_ended")).toMatchObject({
      run_id: started.json().data.run_id,
      payload: expect.objectContaining({
        status: "failed",
        reason: "provider failed",
      }),
    });
    expectTerminalEventTypes(history, started.json().data.run_id).toEqual([
      "error",
      "agent_ended",
      "run_ended",
    ]);
    const outboxRows = listRunOutbox(harness, "failed-runtime-session", started.json().data.run_id);
    expect(outboxRows.map((row) => row.event_type)).toEqual([
      "client.run_started",
      "client.state_sync",
      "client.agent_started",
      "client.state_sync",
      "client.error",
      "client.agent_ended",
      "client.run_ended",
    ]);
    const terminalOutboxRows = filterTerminalOutboxRows(outboxRows);
    expect(terminalOutboxRows.map((row) => row.event_type)).toEqual([
      "client.error",
      "client.agent_ended",
      "client.run_ended",
    ]);
    expect(outboxRows.map((row) => row.status)).toEqual(Array.from({ length: outboxRows.length }, () => "delivered"));
    expect(harness.container.conversationStore.fetchPendingOutbox(10)).toEqual([]);
    expect(projectOutboxEventTypes(terminalOutboxRows)).toEqual([
      "error",
      "agent_ended",
      "run_ended",
    ]);
    expect(logEntries).toEqual([
      {
        message: "agent runtime execution failed",
        bindings: expect.objectContaining({
          error_name: "Error",
          error_message: "provider failed",
          error_stack: expect.stringContaining("provider failed"),
          session_id: "failed-runtime-session",
          run_id: started.json().data.run_id,
          task_id: started.json().data.task_id,
          request_id: "req-runtime-failed",
          agent_name: "orchestrator_agent",
          provider_key: "my_deepseek",
          provider_name: "my",
          provider_type: "deepseek",
          model_name: "deepseek-chat",
          execution_kind: "agent_stream",
        }),
      },
    ]);
  });
});

async function createDefaultChatProvider(
  app: FastifyInstance,
  options: { supportsFunctionCalling?: boolean } = {},
): Promise<void> {
  const provider = await app.inject({
    method: "POST",
    url: "/api/model-adapter/providers",
    payload: {
      name: "my",
      provider_type: "deepseek",
      api_key: "sk-test",
      ...(options.supportsFunctionCalling ? { supports_function_calling: true } : {}),
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

function multipartHeaders(boundary: string): Record<string, string> {
  return {
    "content-type": `multipart/form-data; boundary=${boundary}`,
  };
}

function multipartBody(
  boundary: string,
  fieldName: string,
  filename: string,
  contentType: string,
  content: string,
): string {
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
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

function expectTerminalEventTypes(history: Envelope[], runId: string) {
  return expect(extractTerminalEvents(history, runId).map((event) => event.type));
}

function listRunOutbox(
  harness: Awaited<ReturnType<typeof buildTestHarness>>,
  sessionId: string,
  runId: string,
): OutboxRow[] {
  return harness.container.conversationStore.listOutboxForReplay({
    sessionId,
    runId,
    afterSeq: 0,
    limit: 100,
  });
}

function filterTerminalOutboxRows(rows: OutboxRow[]): OutboxRow[] {
  return rows.filter((row) => isTerminalOutboxRow(row));
}

/**
 * 判定 outbox 行是否为 run 终态产出（recorder 在 recordRunTerminal 里写的事件）：
 * stream_output(final) / agent_ended / run_ended / abort / error。
 * message_saved(state_sync) 不计入——其 payload 不带 role，无法与起始阶段发布的
 * user message_saved 区分；assistant message_saved 的覆盖由 history 的显式断言承担。
 */
function isTerminalOutboxRow(row: OutboxRow): boolean {
  return (
    row.event_type === "client.stream_output" ||
    row.event_type === "client.agent_ended" ||
    row.event_type === "client.run_ended" ||
    row.event_type === "client.abort" ||
    row.event_type === "client.error"
  );
}

function projectOutboxEventTypes(rows: OutboxRow[]) {
  const projector = new EnvelopeProjector();
  return rows.map((row) => projector.toEnvelope(row).type);
}

function extractTerminalEvents(history: Envelope[], runId: string): Envelope[] {
  return history.filter((event) => {
    if (event.run_id !== runId) {
      return false;
    }
    const payload = event.payload as { phase?: string };
    if (event.type === "stream_output") {
      return payload.phase === "final";
    }
    return (
      event.type === "agent_ended" ||
      event.type === "run_ended" ||
      event.type === "abort" ||
      event.type === "error"
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
