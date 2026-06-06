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
    expect(history.find((event) => event.type === "context.usage")).toMatchObject({
      agent_name: "orchestrator_agent",
      data: {
        used_tokens: expect.any(Number),
        system_prompt_tokens: expect.any(Number),
        total_tokens: expect.any(Number),
        budget_tokens: 128000,
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

  it("executes read-only memory tool calls during a minimal runtime-core run", async () => {
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
      "execute_bash",
      "list_memory_index",
      "read_memory_entry",
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
