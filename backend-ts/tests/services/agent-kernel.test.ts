import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import type { AgentRuntimeEvent, KernelResult, MessageRefresher } from "../../src/services/agent/kernel/contracts.js";
import type { AgentPromptContext } from "../../src/services/agent/prompt-builder/index.js";
import { DefaultHookRegistry } from "../../src/services/agent/kernel/hook-registry.js";
import { RuntimeEventSink } from "../../src/services/agent/kernel-plugins/events/runtime-event-sink.js";
import { createAgentKernel } from "../../src/services/agent/kernel-plugins/create-agent-kernel.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatStreamChunkHandler,
  LlmChatClient,
} from "../../src/services/integrations/llm-chat-client.js";
import { renderSemanticBlock, renderToolResultContent } from "../../src/services/agent/kernel-plugins/protocol/xml/index.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
  RuntimeToolWaitRequest,
  RuntimeToolWaitResult,
} from "../../src/services/runtime/runtime-tool-types.js";

class FakeChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly error: Error | null = null) {}

  async complete(request: ChatCompletionRequest) {
    this.requests.push(request);
    if (this.error) {
      throw this.error;
    }
    return { content: "core answer" };
  }

  async stream(request: ChatCompletionRequest, onChunk: ChatStreamChunkHandler) {
    this.requests.push(request);
    if (this.error) {
      throw this.error;
    }
    await onChunk({ content: "core answer" });
    return { content: "core answer" };
  }
}

class FakeStreamingChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  async complete(): Promise<{ content: string }> {
    throw new Error("complete should not be called");
  }

  async stream(request: ChatCompletionRequest, onChunk: ChatStreamChunkHandler) {
    this.requests.push(request);
    if ((await onChunk({ content: "hello " }))?.stop) {
      return { content: "hello " };
    }
    if ((await onChunk({ content: "core" }))?.stop) {
      return { content: "hello core" };
    }
    return { content: "hello core" };
  }
}

class FakeXmlStreamingToolChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  constructor(private readonly responses: string[][]) {}

  async complete(): Promise<{ content: string }> {
    throw new Error("complete should not be called for XML streaming tool loops");
  }

  async stream(request: ChatCompletionRequest, onChunk: ChatStreamChunkHandler) {
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

class FakeRuntimeToolExecutor implements RuntimeToolExecutor {
  readonly calls: Array<{ call: RuntimeToolCall; context: RuntimeToolExecutionContext }> = [];

  constructor(private readonly includeSkillTools = false) {}

  listVisibleTools(): RuntimeToolDefinition[] {
    const tools: RuntimeToolDefinition[] = [
      {
        name: "list_memory_index",
        description: "List memory index",
        parameters: {
          type: "object",
          required: ["scope"],
          properties: {
            scope: { type: "string" },
          },
        },
      },
    ];
    if (this.includeSkillTools) {
      tools.push({
        name: "execute_skill_script",
        description: "Execute a Skill utility script. The arguments field is argv-style: each command-line token must be one array item.",
        parameters: {
          type: "object",
          required: ["skill_name", "script_name"],
          properties: {
            skill_name: { type: "string", description: "Skill name." },
            script_name: { type: "string", description: "Script file name under the Skill scripts directory." },
            arguments: {
              type: "array",
              items: { type: "string" },
              description: "Command line argv tokens. XML calls must use <item> children, one token per item.",
            },
          },
        },
      });
    }
    return tools;
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    this.calls.push({ call, context });
    return {
      success: true,
      tool_name: call.toolName,
      summary: "已读取 session MEMORY 索引",
      answer: null,
      output_type: "text",
      content: "# Session Memory\n- fact_alpha.md",
      metadata: {
        scope: "session",
      },
      artifacts: [],
      llm_hint: null,
    };
  }
}

class FakeLargePayloadToolExecutor implements RuntimeToolExecutor {
  readonly calls: Array<{ call: RuntimeToolCall; context: RuntimeToolExecutionContext }> = [];
  readonly rows = Array.from({ length: 80 }, (_, index) => ({
    id: index + 1,
    name: `row_${index + 1}`,
    payload: `${index === 79 ? "unique-tail-marker" : "payload"}_${"x".repeat(120)}`,
  }));

  listVisibleTools(): RuntimeToolDefinition[] {
    return [
      {
        name: "query_large_data",
        description: "Query large data",
        parameters: { type: "object", properties: {} },
      },
    ];
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    this.calls.push({ call, context });
    return {
      success: true,
      tool_name: "query_large_data",
      summary: "已查询大数据",
      answer: null,
      output_type: "json",
      content: this.rows,
      metadata: {
        total_count: this.rows.length,
        data_type: "Rows",
        fields: [
          { name: "id" },
          { name: "name" },
          { name: "payload" },
        ],
        sample: this.rows.slice(0, 1),
      },
      artifacts: [],
      llm_hint: null,
    };
  }
}

class FakeReferenceToolExecutor implements RuntimeToolExecutor {
  readonly calls: Array<{ call: RuntimeToolCall; context: RuntimeToolExecutionContext }> = [];

  listVisibleTools(): RuntimeToolDefinition[] {
    return [
      {
        name: "write_file",
        description: "Write file",
        parameters: {
          type: "object",
          required: ["content"],
          properties: {
            content: { type: "string" },
          },
        },
      },
      {
        name: "read_file",
        description: "Read file",
        parameters: {
          type: "object",
          required: ["file_path"],
          properties: {
            file_path: { type: "string" },
          },
        },
      },
    ];
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    this.calls.push({ call, context });
    if (call.toolName === "write_file") {
      return {
        success: true,
        tool_name: "write_file",
        summary: "文件已写入",
        answer: null,
        output_type: "json",
        content: {
          file_path: "E:/tmp/generated.txt",
          display_path: "./data/sessions/s1/workspace/generated.txt",
        },
        metadata: {
          file_path: "E:/tmp/generated.txt",
        },
        artifacts: [],
        llm_hint: null,
      };
    }
    return {
      success: true,
      tool_name: call.toolName,
      summary: "文件已读取",
      answer: null,
      output_type: "text",
      content: "read ok",
      metadata: {
        file_path: String(call.arguments?.file_path ?? ""),
      },
      artifacts: [],
      llm_hint: null,
    };
  }
}

class FakeDependencyToolExecutor implements RuntimeToolExecutor {
  readonly calls: Array<{ call: RuntimeToolCall; context: RuntimeToolExecutionContext; startedAt: number; finishedAt: number }> = [];

  listVisibleTools(): RuntimeToolDefinition[] {
    return [
      {
        name: "seed_file",
        description: "Seed file",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "read_file",
        description: "Read file",
        parameters: {
          type: "object",
          required: ["file_path"],
          properties: { file_path: { type: "string" } },
        },
      },
      {
        name: "list_memory_index",
        description: "List memory index",
        parameters: { type: "object", properties: {} },
      },
    ];
  }

  async executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    const startedAt = Date.now();
    if (call.toolName === "seed_file" || call.toolName === "list_memory_index") {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const finishedAt = Date.now();
    this.calls.push({ call, context, startedAt, finishedAt });
    if (call.toolName === "seed_file") {
      return {
        success: true,
        tool_name: "seed_file",
        summary: "seeded",
        answer: null,
        output_type: "json",
        content: {
          file_path: "E:/tmp/seed.txt",
        },
        metadata: {},
        artifacts: [],
        llm_hint: null,
      };
    }
    if (call.toolName === "read_file") {
      return {
        success: true,
        tool_name: "read_file",
        summary: "read",
        answer: null,
        output_type: "text",
        content: `read ${String(call.arguments?.file_path ?? "")}`,
        metadata: {},
        artifacts: [],
        llm_hint: null,
      };
    }
    return {
      success: true,
      tool_name: "list_memory_index",
      summary: "listed",
      answer: null,
      output_type: "text",
      content: "# Session Memory",
      metadata: {},
      artifacts: [],
      llm_hint: null,
    };
  }
}

class FakeThrowingToolExecutor implements RuntimeToolExecutor {
  readonly calls: RuntimeToolCall[] = [];

  listVisibleTools(): RuntimeToolDefinition[] {
    return [
      {
        name: "list_memory_index",
        description: "List memory index",
        parameters: { type: "object", properties: {} },
      },
    ];
  }

  executeTool(call: RuntimeToolCall): never {
    this.calls.push(call);
    throw new Error("tool exploded");
  }
}

class FakeAbortingToolExecutor implements RuntimeToolExecutor {
  readonly calls: RuntimeToolCall[] = [];

  constructor(private readonly controller: AbortController) {}

  listVisibleTools(): RuntimeToolDefinition[] {
    return [
      {
        name: "list_memory_index",
        description: "List memory index",
        parameters: { type: "object", properties: {} },
      },
    ];
  }

  executeTool(call: RuntimeToolCall): never {
    this.calls.push(call);
    this.controller.abort();
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

class FakeCircularResultToolExecutor implements RuntimeToolExecutor {
  readonly calls: RuntimeToolCall[] = [];

  listVisibleTools(): RuntimeToolDefinition[] {
    return [
      {
        name: "preview_data_structure",
        description: "Preview data",
        parameters: { type: "object", properties: {} },
      },
    ];
  }

  executeTool(call: RuntimeToolCall) {
    this.calls.push(call);
    const content: Record<string, unknown> = { label: "circular" };
    content.self = content;
    return {
      success: true,
      tool_name: call.toolName,
      summary: "circular result",
      answer: null,
      output_type: "json",
      content,
      metadata: {},
      artifacts: [],
      llm_hint: null,
    };
  }
}

class FakeWaitingToolExecutor implements RuntimeToolExecutor {
  readonly calls: Array<{ call: RuntimeToolCall; context: RuntimeToolExecutionContext }> = [];
  readonly waits: Array<{ request: RuntimeToolWaitRequest; context: RuntimeToolExecutionContext }> = [];

  listVisibleTools(): RuntimeToolDefinition[] {
    return [
      {
        name: "task_output",
        description: "Read background task output",
        parameters: { type: "object", properties: {} },
      },
    ];
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    this.calls.push({ call, context });
    const taskId = String(call.arguments?.task_id ?? "bg-1");
    return {
      success: true,
      tool_name: "task_output",
      summary: `后台任务 ${taskId} 仍在运行，已进入等待`,
      answer: null,
      output_type: "json",
      content: {
        task_id: taskId,
        status: "running",
        completed: false,
        background_task_id: taskId,
        suggest_wait: true,
        wait_timeout_ms: 3000,
      },
      metadata: {
        background_task_id: taskId,
        suggest_wait: true,
        wait_timeout_ms: 3000,
      },
      artifacts: [],
      llm_hint: null,
    };
  }

  waitForToolResult(
    request: RuntimeToolWaitRequest,
    context: RuntimeToolExecutionContext,
  ): RuntimeToolWaitResult {
    this.waits.push({ request, context });
    return {
      success: true,
      timeout: false,
      payloads: [
        {
          task_id: request.backgroundTaskId,
          background_task_id: request.backgroundTaskId,
          status: "completed",
          return_code: 0,
          result_type: "bash_output",
          output_path: "data/sessions/s1/transient/bg_123.log",
          success: true,
          summary: `后台任务 ${request.backgroundTaskId} 已完成，输出已写入文件`,
        },
      ],
    };
  }
}

type TestRunInput = {
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName: string;
  conversation: ChatMessage[];
  promptContext?: AgentPromptContext;
  toolExecutor?: RuntimeToolExecutor;
  toolContext?: RuntimeToolExecutionContext;
  signal?: AbortSignal;
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
  conversationUpdateProvider?: () => Promise<ChatMessage[]> | ChatMessage[];
  onModelRequestSuccess?: () => void;
};

/**
 * 测试 fixture：把旧 AgentRuntimeCore.runText(input) 契约适配到 kernel.run(session)。
 * 仅测试用——onEvent / conversationUpdateProvider / onModelRequestSuccess 三回调重新映射为
 * EventSink / MessageRefresher / afterModel hook，与生产 run-engine 接线等价，让全部黑盒断言
 * （事件序列、输出、buildRequest 组装）在内核结构下继续验证"行为零变化"。
 */
function createTestRuntime(client: LlmChatClient, options?: { dataRoot?: string }) {
  return {
    async runText(input: TestRunInput): Promise<KernelResult> {
      const eventSink = new RuntimeEventSink((event) => {
        input.onEvent?.(event);
      });
      const refresher: MessageRefresher = {
        refresh: async () => input.conversationUpdateProvider?.() ?? [],
      };
      const hooks = new DefaultHookRegistry();
      if (input.onModelRequestSuccess) {
        hooks.register("afterModel", () => input.onModelRequestSuccess?.());
      }
      const kernel = createAgentKernel({
        llmChatClient: client,
        provider: input.provider,
        dataRoot: options?.dataRoot ?? os.tmpdir(),
        eventSink,
        refresher,
        hooks,
      });
      return kernel.run({
        agent: input.agent,
        provider: input.provider,
        modelName: input.modelName,
        conversation: input.conversation,
        promptContext: input.promptContext,
        toolExecutor: input.toolExecutor,
        toolContext: input.toolContext,
        signal: input.signal,
        sessionId: "test-session",
        runId: "test-run",
        taskId: null,
        requestId: null,
        rootCallId: "test-root",
      });
    },
  };
}

describe("AgentKernel", () => {
  it("runs text with only agent, provider, model, and conversation input", async () => {
    const client = new FakeChatClient();
    const core = createTestRuntime(client);

    const result = await core.runText({
      agent: minimalAgent(),
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "hello" }],
    });

    expect(result).toEqual({
      content: "core answer",
      finish_reason: null,
      metadata: {
        agent_name: "orchestrator_agent",
        provider_key: "my_deepseek",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
      },
    });
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toMatchObject({
      model: "deepseek-chat",
      provider: { key: "my_deepseek" },
      temperature: 0.2,
      maxCompletionTokens: 1024,
      messages: [
        { role: "system", content: expect.stringContaining("<system_instruction") },
        { role: "user", content: expect.stringContaining("<user_input") },
      ],
    });
    expect(client.requests[0]?.messages[0]?.content).toContain("You are RAGSystem");
    expect(client.requests[0]?.messages[0]?.content).toContain("You are the core.");
    expect(client.requests[0]?.messages[0]?.content).toContain("## 输出格式");
    expect(client.requests[0]?.messages[0]?.content).toContain("## 执行规则");
    expect(client.requests[0]?.messages[0]?.content).not.toContain("### 数据文件传递规则");
    expect(client.requests[0]?.messages[1]?.content).toContain("hello");
  });

  it("merges leading system context with the agent system prompt", async () => {
    const client = new FakeChatClient();
    const core = createTestRuntime(client);

    await core.runText({
      agent: minimalAgent(),
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [
        { role: "system", content: "[Memory Scope Capabilities]\n- 可读取 scope: session" },
        { role: "user", content: "hello" },
      ],
    });

    expect(client.requests[0]?.messages).toEqual([
      {
        role: "system",
        content: expect.stringContaining("<context source=\"memory\">"),
      },
      { role: "user", content: expect.stringContaining("<user_input") },
    ]);
    expect(client.requests[0]?.messages[0]?.content).toContain("You are the core.");
    expect(client.requests[0]?.messages[0]?.content).toContain("[Memory Scope Capabilities]");
  });

  it("keeps ordinary persisted system history outside the stable system prefix", async () => {
    const client = new FakeChatClient();
    const core = createTestRuntime(client);

    await core.runText({
      agent: minimalAgent(),
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [
        { role: "system", content: "[Memory Scope Capabilities]\n- 可读取 scope: session" },
        { role: "system", content: "persisted runtime note" },
        { role: "user", content: "hello" },
      ],
    });

    expect(client.requests[0]?.messages).toEqual([
      {
        role: "system",
        content: expect.stringContaining("<context source=\"memory\">"),
      },
      {
        role: "system",
        content: expect.stringContaining("<runtime_instruction"),
      },
      { role: "user", content: expect.stringContaining("<user_input") },
    ]);
    expect(client.requests[0]?.messages[0]?.content).toContain("[Memory Scope Capabilities]");
    expect(client.requests[0]?.messages[0]?.content).not.toContain("persisted runtime note");
    expect(client.requests[0]?.messages[1]?.content).toContain("persisted runtime note");
  });

  it("emits provider-stream events without depending on backend session state", async () => {
    const client = new FakeStreamingChatClient();
    const core = createTestRuntime(client);
    const events: AgentRuntimeEvent[] = [];

    const result = await core.runText({
      agent: minimalAgent(),
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "stream" }],
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toEqual({
      content: "hello core",
      finish_reason: null,
      metadata: {
        agent_name: "orchestrator_agent",
        provider_key: "my_deepseek",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
      },
    });
    expect(events).toEqual([
      {
        type: "runtime.first_token",
        data: {
          elapsed_ms: expect.any(Number),
          agent_name: "orchestrator_agent",
        },
      },
      {
        type: "runtime.output_delta",
        data: {
          content: "hello ",
          agent_name: "orchestrator_agent",
        },
      },
      {
        type: "runtime.output_delta",
        data: {
          content: "core",
          agent_name: "orchestrator_agent",
        },
      },
    ]);
  });

  it("streams XML intent, executes XML tool calls, and returns final_answer", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      [
        "<intent>",
        "我先查看 session 记忆。",
        "</intent><tool_calls>",
        '<tool name="list_memory_index"><scope>session</scope></tool>',
        "</tool_calls>",
      ],
      ["<final_answer>", "I used the session memory index.", "</final_answer>"],
    ]);
    const tools = new FakeRuntimeToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();
    const events: AgentRuntimeEvent[] = [];

    const result = await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "check memory" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      content: "I used the session memory index.",
      finish_reason: "stop",
    });
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.tools).toBeUndefined();
    expect(client.requests[0]?.toolChoice).toBeUndefined();
    expect(client.requests[0]?.messages[0]?.content).toContain("<runtime_instruction");
    expect(client.requests[0]?.messages[0]?.content).toContain("<tool_manifest>");
    expect(client.requests[0]?.messages[0]?.content).toContain("## 可直接调用的工具");
    expect(client.requests[0]?.messages[0]?.content).toContain("### list_memory_index");
    expect(client.requests[0]?.messages[0]?.content).toContain("## 输出格式");
    expect(client.requests[0]?.messages[0]?.content).toContain("## 执行规则");
    expect(client.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining("<tool_calls>"),
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("<tool_result"),
        }),
      ]),
    );
    const xmlToolResultMessage = client.requests[1]?.messages.find((message) =>
      message.role === "user" && message.content.includes("<tool_result"),
    );
    expect(xmlToolResultMessage?.content).toContain('id="xml_round_0_call_1"');
    expect(xmlToolResultMessage?.content).toContain('ok="true"');
    expect(xmlToolResultMessage?.content).toContain("# Session Memory");
    expect(xmlToolResultMessage?.content).not.toContain('"artifacts"');
    expect(tools.calls).toMatchObject([
      {
        call: {
          toolName: "list_memory_index",
          arguments: { scope: "session" },
          callId: "xml_round_0_call_1",
        },
        context: {
          sessionId: "s1",
          runId: "run-1",
          requestId: "req-1",
          currentAgentName: "orchestrator_agent",
          parentCallId: "call-root",
          toolCallId: "xml_round_0_call_1",
          round: 0,
          order: 1,
          roundIndex: 1,
        },
      },
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "runtime.intent_delta",
          data: expect.objectContaining({ content: "我先查看 session 记忆。", round: 0 }),
        }),
        expect.objectContaining({
          type: "runtime.intent_complete",
          data: expect.objectContaining({ content: "我先查看 session 记忆。", round: 0 }),
        }),
        expect.objectContaining({
          type: "runtime.assistant_intermediate",
          data: expect.objectContaining({
            message: expect.objectContaining({
              role: "assistant",
              content: "我先查看 session 记忆。",
              tool_calls: expect.arrayContaining([
                expect.objectContaining({ function: expect.objectContaining({ name: "list_memory_index" }) }),
              ]),
            }),
            round: 0,
          }),
        }),
        expect.objectContaining({
          type: "runtime.tool_call",
          data: expect.objectContaining({ tool_name: "list_memory_index" }),
        }),
        expect.objectContaining({
          type: "runtime.tool_result",
          data: expect.objectContaining({ success: true }),
        }),
        expect.objectContaining({
          type: "runtime.observation_complete",
          data: expect.objectContaining({
            messages: expect.arrayContaining([
              expect.objectContaining({ content: expect.stringContaining("<tool_result") }),
            ]),
            round: 0,
          }),
        }),
        expect.objectContaining({
          type: "runtime.output_delta",
          data: expect.objectContaining({ content: "I used the session memory index." }),
        }),
      ]),
    );
  });

  it("renders execute_skill_script XML arguments as itemized argv tokens in the prompt", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      ["<final_answer>", "done", "</final_answer>"],
    ]);
    const tools = new FakeRuntimeToolExecutor(true);
    const core = createTestRuntime(client);
    const agent = minimalAgent();

    await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "show prompt" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
    });

    const prompt = client.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("### execute_skill_script");
    expect(prompt).toContain("<arguments>");
    expect(prompt).toContain("<item>--data</item>");
    expect(prompt).toContain("<item>--x-field</item>");
    expect(prompt).toContain("不要用 `<arg>`");
    expect(prompt).toContain("不要把多个参数合并成一个字符串或 JSON 对象");
  });

  it("does not stream untagged XML prelude as final answer content", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      [
        "我先查看 session 记忆。",
        "<tool_calls>",
        '<tool name="list_memory_index"><scope>session</scope></tool>',
        "</tool_calls>",
      ],
      [
        "准备回答。",
        "<final_answer>",
        "I used the session memory index.",
        "</final_answer>",
      ],
    ]);
    const tools = new FakeRuntimeToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();
    const events: AgentRuntimeEvent[] = [];

    const result = await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "check memory" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.content).toBe("I used the session memory index.");
    const outputDeltas = events.filter((event) => event.type === "runtime.output_delta");
    expect(outputDeltas).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ content: "I used the session memory index." }),
      }),
    ]);
    expect(outputDeltas.map((event) => event.data.content).join("")).not.toContain("我先查看");
    expect(outputDeltas.map((event) => event.data.content).join("")).not.toContain("准备回答");
  });

  it("feeds protocol feedback back to the model when XML tool calls are malformed", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      ["<tool_calls>not a tool</tool_calls>"],
      ["<final_answer>repaired answer</final_answer>"],
    ]);
    const tools = new FakeRuntimeToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();

    const result = await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "check memory" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
    });

    expect(result.content).toBe("repaired answer");
    expect(client.requests).toHaveLength(2);
    expect(client.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("<protocol_feedback"),
        }),
      ]),
    );
    expect(tools.calls).toHaveLength(0);
  });

  it("resolves same-round XML tool result placeholders before executing dependent tools", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      [
        "<tool_calls>",
        '<tool name="write_file"><content>demo</content></tool>',
        '<tool name="read_file"><file_path>{result_1.content.file_path}</file_path></tool>',
        "</tool_calls>",
      ],
      ["<final_answer>", "done", "</final_answer>"],
    ]);
    const tools = new FakeReferenceToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();

    await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "write then read" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
    });

    expect(tools.calls).toHaveLength(2);
    expect(tools.calls[1]?.call).toMatchObject({
      toolName: "read_file",
      arguments: {
        file_path: "E:/tmp/generated.txt",
      },
    });
    expect(tools.calls.map((item) => item.context)).toMatchObject([
      {
        toolCallId: "xml_round_0_call_1",
        round: 0,
        order: 1,
        roundIndex: 1,
      },
      {
        toolCallId: "xml_round_0_call_2",
        round: 0,
        order: 2,
        roundIndex: 2,
      },
    ]);
  });

  it("feeds same-round XML tool observations as one Python-style user message", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      [
        "<tool_calls>",
        '<tool name="list_memory_index"><scope>session</scope></tool>',
        '<tool name="list_memory_index"><scope>session</scope></tool>',
        "</tool_calls>",
      ],
      ["<final_answer>", "done", "</final_answer>"],
    ]);
    const tools = new FakeRuntimeToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();

    await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "check twice" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
    });

    const userToolMessages = client.requests[1]?.messages.filter((message) =>
      message.role === "user" && message.content.includes("<tool_result"),
    );
    expect(userToolMessages).toHaveLength(2);
    expect(userToolMessages?.[0]?.content).toContain('id="xml_round_0_call_1"');
    expect(userToolMessages?.[1]?.content).toContain('id="xml_round_0_call_2"');
  });

  it("stops the XML round after tool calls and ignores same-round final answers", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      [
        "<tool_calls>",
        '<tool name="list_memory_index"><scope>session</scope></tool>',
        "</tool_calls><final_answer>should not be streamed or persisted</final_answer>",
      ],
      ["<final_answer>", "answer after observation", "</final_answer>"],
    ]);
    const tools = new FakeRuntimeToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();
    const events: AgentRuntimeEvent[] = [];

    const result = await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "check memory before answering" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.content).toBe("answer after observation");
    expect(tools.calls).toHaveLength(1);
    expect(client.requests).toHaveLength(2);
    const firstAssistantMessage = client.requests[1]?.messages.find((message) => message.role === "assistant");
    expect(firstAssistantMessage?.content).toBe(
      '<tool_calls><tool name="list_memory_index"><scope>session</scope></tool></tool_calls>',
    );
    expect(firstAssistantMessage?.content).not.toContain("should not be streamed");
    const streamedContent = events
      .filter((event) => event.type === "runtime.output_delta")
      .map((event) => event.data.content)
      .join("");
    expect(streamedContent).toBe("answer after observation");
    expect(streamedContent).not.toContain("should not be streamed");
  });

  it("executes XML tool calls in Python-style dependency batches", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      [
        "<tool_calls>",
        '<tool name="read_file"><file_path>{result_2.content.file_path}</file_path></tool>',
        '<tool name="seed_file"></tool>',
        '<tool name="list_memory_index"></tool>',
        "</tool_calls>",
      ],
      ["<final_answer>", "done", "</final_answer>"],
    ]);
    const tools = new FakeDependencyToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();
    const events: AgentRuntimeEvent[] = [];

    await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "dependency batch" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(tools.calls.map((item) => item.call.toolName)).toEqual(["seed_file", "list_memory_index", "read_file"]);
    expect(tools.calls[2]?.call.arguments).toEqual({ file_path: "E:/tmp/seed.txt" });
    expect(tools.calls[1]?.startedAt).toBeGreaterThanOrEqual(tools.calls[0]?.finishedAt ?? 0);
    expect(tools.calls.map((item) => item.context.roundIndex)).toEqual([2, 3, 1]);

    const userToolMessages = client.requests[1]?.messages.filter((message) =>
      message.role === "user" && message.content.includes("<tool_result"),
    );
    expect(userToolMessages).toHaveLength(3);
    expect(userToolMessages?.[0]?.content).toContain('id="xml_round_0_call_1"');
    expect(userToolMessages?.[1]?.content).toContain('id="xml_round_0_call_2"');
    expect(userToolMessages?.[2]?.content).toContain('id="xml_round_0_call_3"');

    const toolEvents = events.filter((event) => event.type === "runtime.tool_call" || event.type === "runtime.tool_result");
    expect(toolEvents.map((event) => event.data.tool_name)).toEqual([
      "seed_file",
      "seed_file",
      "list_memory_index",
      "list_memory_index",
      "read_file",
      "read_file",
    ]);
  });

  it("turns XML tool execution exceptions into failed observations", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      ["<tool_calls>", '<tool name="list_memory_index"></tool>', "</tool_calls>"],
      ["<final_answer>", "recovered", "</final_answer>"],
    ]);
    const tools = new FakeThrowingToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();
    const events: AgentRuntimeEvent[] = [];

    const result = await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "tool failure" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.content).toBe("recovered");
    const userToolMessage = client.requests[1]?.messages.find((message) =>
      message.role === "user" && message.content.includes("<tool_result"),
    );
    expect(userToolMessage?.content).toContain('ok="false"');
    expect(userToolMessage?.content).toContain("tool exploded");
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "runtime.tool_result",
          data: expect.objectContaining({
            tool_name: "list_memory_index",
            success: false,
            summary: "tool exploded",
            raw_result_available: true,
          }),
        },
      ]),
    );
  });

  it("propagates tool aborts as run interruption without failed observations", async () => {
    const controller = new AbortController();
    const client = new FakeXmlStreamingToolChatClient([
      ["<tool_calls>", '<tool name="list_memory_index"></tool>', "</tool_calls>"],
      ["<final_answer>", "should not be requested", "</final_answer>"],
    ]);
    const tools = new FakeAbortingToolExecutor(controller);
    const core = createTestRuntime(client);
    const events: AgentRuntimeEvent[] = [];
    const agent = minimalAgent();

    await expect(
      core.runText({
        agent,
        provider: minimalProvider(),
        modelName: "deepseek-chat",
        signal: controller.signal,
        conversation: [{ role: "user", content: "abort during tool" }],
        toolExecutor: tools,
        toolContext: {
          agent,
          sessionId: "s1",
          runId: "run-1",
          requestId: "req-1",
          currentAgentName: "orchestrator_agent",
          signal: controller.signal,
        },
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(controller.signal.aborted).toBe(true);
    expect(client.requests).toHaveLength(1);
    expect(tools.calls).toHaveLength(1);
    expect(events.some((event) => event.type === "runtime.tool_result")).toBe(false);
    expect(events.some((event) => event.type === "runtime.error")).toBe(false);
  });

  it("repairs an empty XML streaming round instead of failing before protocol feedback", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      [],
      ["<final_answer>", "recovered after empty stream", "</final_answer>"],
    ]);
    const core = createTestRuntime(client);
    const agent = minimalAgent();
    const events: AgentRuntimeEvent[] = [];

    const result = await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "empty stream repair" }],
      toolExecutor: new FakeRuntimeToolExecutor(),
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.content).toBe("recovered after empty stream");
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.allowEmptyStream).toBe(true);
    expect(client.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        { role: "assistant", content: "" },
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("no final_answer or tool_calls found"),
        }),
      ]),
    );
  });

  it("turns tool observation rendering failures into failed observations", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      ["<tool_calls>", '<tool name="preview_data_structure"></tool>', "</tool_calls>"],
      ["<final_answer>", "recovered after observation error", "</final_answer>"],
    ]);
    const tools = new FakeCircularResultToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();
    const events: AgentRuntimeEvent[] = [];

    const result = await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "tool observation failure" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.content).toBe("recovered after observation error");
    const userToolMessage = client.requests[1]?.messages.find((message) =>
      message.role === "user" && message.content.includes("<tool_result"),
    );
    expect(userToolMessage?.content).toContain('ok="false"');
    expect(userToolMessage?.content).toContain("Tool result observation failed");
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: "runtime.tool_result",
          data: expect.objectContaining({
            tool_name: "preview_data_structure",
            success: false,
            summary: expect.stringContaining("Tool result observation failed"),
          }),
        },
      ]),
    );
  });

  it("waits for suggested background tool results before feeding XML observations", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      [
        "<tool_calls>",
        '<tool name="task_output"><task_id>bg-1</task_id><block>true</block></tool>',
        "</tool_calls>",
      ],
      ["<final_answer>", "done", "</final_answer>"],
    ]);
    const tools = new FakeWaitingToolExecutor();
    const core = createTestRuntime(client);
    const agent = minimalAgent();
    const events: AgentRuntimeEvent[] = [];

    await core.runText({
      agent,
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "wait for background" }],
      toolExecutor: tools,
      toolContext: {
        agent,
        sessionId: "s1",
        runId: "run-1",
        requestId: "req-1",
        currentAgentName: "orchestrator_agent",
        parentCallId: "call-root",
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(tools.waits).toMatchObject([
      {
        request: {
          backgroundTaskId: "bg-1",
          timeoutMs: 3000,
        },
        context: {
          sessionId: "s1",
          runId: "run-1",
          requestId: "req-1",
          toolCallId: "xml_round_0_call_1",
        },
      },
    ]);
    const userToolMessage = client.requests[1]?.messages.find((message) =>
      message.role === "user" && message.content.includes("<task-notification>"),
    );
    expect(userToolMessage?.content).toContain("<task-notification>");
    expect(userToolMessage?.content).toContain("<task-id>bg-1</task-id>");
    expect(userToolMessage?.content).toContain("<output-file>data/sessions/s1/transient/bg_123.log</output-file>");
    expect(userToolMessage?.content).toContain("<summary>后台任务 bg-1 已完成，输出已写入文件</summary>");
    expect(userToolMessage?.content).toContain("</task-notification>");
    const toolResult = events.find((event) => event.type === "runtime.tool_result");
    expect(toolResult).toMatchObject({
      type: "runtime.tool_result",
      data: {
        tool_name: "task_output",
        success: true,
        summary: "后台任务 bg-1 已完成，输出已写入文件",
        observation: expect.stringContaining("<task-notification>"),
        raw_result: {
          background_notifications: [
            expect.objectContaining({
              background_task_id: "bg-1",
              status: "completed",
            }),
          ],
        },
      },
    });
  });

  it("renders request_user_input tool results as compact semantic observations", () => {
    const content = renderToolResultContent({
      callId: "input_call_1",
      toolName: "request_user_input",
      result: {
        success: true,
        tool_name: "request_user_input",
        summary: "用户已回复",
        answer: null,
        output_type: "text",
        content: "使用 session memory",
        metadata: {},
        artifacts: [],
        llm_hint: null,
      },
    });

    expect(content).toBe(
      '<tool_result id="input_call_1" name="request_user_input" ok="true" semantic="user_input_response"><![CDATA[使用 session memory]]></tool_result>',
    );
  });

  it("renders text tool observations with Python-style summary and llm hint", () => {
    const content = renderToolResultContent({
      callId: "read_call_1",
      toolName: "read_file",
      result: {
        success: true,
        tool_name: "read_file",
        summary: "读取成功",
        answer: null,
        output_type: "text",
        content: "file content",
        metadata: {},
        artifacts: [],
        llm_hint: "可用 preview_data_structure 查看结构",
      },
    });

    expect(content).toBe(
      '<tool_result id="read_call_1" name="read_file" ok="true"><![CDATA[读取成功\n\nfile content\n可用 preview_data_structure 查看结构]]></tool_result>',
    );
  });

  it("renders structured tool observations with summary and json detail", () => {
    const content = renderToolResultContent({
      callId: "preview_call_1",
      toolName: "preview_data_structure",
      result: {
        success: true,
        tool_name: "preview_data_structure",
        summary: "预览成功",
        answer: null,
        output_type: "json",
        content: { file_type: "json", structure: { type: "object" } },
        metadata: {},
        artifacts: [],
        llm_hint: null,
      },
    });

    expect(content).toBe(
      [
        '<tool_result id="preview_call_1" name="preview_data_structure" ok="true"><![CDATA[预览成功',
        "",
        "```json",
        JSON.stringify({ file_type: "json", structure: { type: "object" } }, null, 2),
        "```]]></tool_result>",
      ].join("\n"),
    );
  });

  it("renders execute_bash observations without internal noise fields", () => {
    const content = renderToolResultContent({
      callId: "bash_call_1",
      toolName: "execute_bash",
      result: {
        success: true,
        tool_name: "execute_bash",
        summary: "命令执行完成，返回码 0",
        answer: null,
        output_type: "json",
        content: {
          stdout: "hello world",
          stderr: "",
          return_code: 0,
          interrupted: false,
          background_task_id: null,
          classification: "read_only",
        },
        metadata: {},
        artifacts: [],
        llm_hint: null,
      },
    });

    expect(content).toContain("命令执行完成，返回码 0\nhello world");
    expect(content).not.toContain("classification");
    expect(content).not.toContain("background_task_id");
    expect(content).not.toContain("interrupted");
    expect(content).not.toContain("false");
    expect(content).not.toContain("null");
  });

  it("renders execute_bash stderr and nonzero return codes like Python", () => {
    const content = renderToolResultContent({
      callId: "bash_call_2",
      toolName: "execute_bash",
      result: {
        success: true,
        tool_name: "execute_bash",
        summary: "命令执行完成，返回码 127",
        answer: null,
        output_type: "json",
        content: {
          stdout: "partial stdout",
          stderr: "command not found",
          return_code: 127,
          interrupted: false,
          background_task_id: null,
          classification: "unknown",
        },
        metadata: {},
        artifacts: [],
        llm_hint: null,
      },
    });

    expect(content).toContain("命令执行完成，返回码 127");
    expect(content).toContain("[stderr]\ncommand not found");
    expect(content).toContain("[stdout]\npartial stdout");
  });

  it("renders execute_bash background and interrupted observations compactly", () => {
    const background = renderToolResultContent({
      callId: "bash_call_3",
      toolName: "execute_bash",
      result: {
        success: true,
        tool_name: "execute_bash",
        summary: "后台任务已启动",
        answer: null,
        output_type: "json",
        content: {
          stdout: "",
          stderr: "",
          return_code: null,
          interrupted: false,
          background_task_id: "bg-123",
          classification: "read_only",
        },
        metadata: {},
        artifacts: [],
        llm_hint: null,
      },
    });
    const interrupted = renderToolResultContent({
      callId: "bash_call_4",
      toolName: "execute_bash",
      result: {
        success: true,
        tool_name: "execute_bash",
        summary: "命令执行超时（60 秒），进程已终止",
        answer: null,
        output_type: "json",
        content: {
          stdout: "partial output",
          stderr: "",
          return_code: -1,
          interrupted: true,
          background_task_id: null,
          classification: "read_only",
        },
        metadata: {},
        artifacts: [],
        llm_hint: null,
      },
    });

    expect(background).toContain("task_id: bg-123");
    expect(background).not.toContain("classification");
    expect(interrupted).toContain("命令执行超时（60 秒），进程已终止\npartial output");
    expect(interrupted).not.toContain("classification");
  });

  it("emits a runtime error event before rethrowing provider failures", async () => {
    const client = new FakeChatClient(new Error("provider failed"));
    const core = createTestRuntime(client);
    const events: AgentRuntimeEvent[] = [];

    await expect(
      core.runText({
        agent: minimalAgent(),
        provider: minimalProvider(),
        modelName: "deepseek-chat",
        conversation: [{ role: "user", content: "fail" }],
        onEvent: (event) => {
          events.push(event);
        },
      }),
    ).rejects.toThrow("provider failed");

    expect(events).toEqual([
      {
        type: "runtime.error",
        data: {
          message: "provider failed",
          agent_name: "orchestrator_agent",
        },
      },
    ]);
  });
});

function minimalAgent(): AgentConfig {
  return {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator Agent",
    description: null,
    enabled: true,
    default_entry: true,
    llm_tiers: {
      default: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        temperature: 0.2,
        max_completion_tokens: 1024,
        extra_params: {},
      },
    },
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: ["team", "session"],
      write_scopes: ["session"],
      archive_scopes: ["session"],
    },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: {
      behavior: {
        system_prompt: "You are the core.",
      },
    },
  };
}

function minimalProvider(): ModelProviderConfig {
  return {
    name: "my",
    provider_type: "deepseek",
    key: "my_deepseek",
    api_key: "sk-test",
    models: ["deepseek-chat"],
    model_map: {
      chat: "deepseek-chat",
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
