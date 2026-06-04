import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { AgentRuntimeCore, type AgentRuntimeEvent } from "../../src/services/agent-runtime-core.js";
import type { ChatCompletionRequest, ChatCompletionResult, LlmChatClient } from "../../src/services/llm-chat-client.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
} from "../../src/services/runtime-tool-types.js";

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
}

class FakeStreamingChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  async complete(): Promise<{ content: string }> {
    throw new Error("complete should not be called");
  }

  async stream(request: ChatCompletionRequest, onChunk: (chunk: { content: string }) => void | Promise<void>) {
    this.requests.push(request);
    await onChunk({ content: "hello " });
    await onChunk({ content: "core" });
    return { content: "hello core" };
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

class FakeRuntimeToolExecutor implements RuntimeToolExecutor {
  readonly calls: Array<{ call: RuntimeToolCall; context: RuntimeToolExecutionContext }> = [];

  listVisibleTools(): RuntimeToolDefinition[] {
    return [
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

describe("AgentRuntimeCore", () => {
  it("runs text with only agent, provider, model, and conversation input", async () => {
    const client = new FakeChatClient();
    const core = new AgentRuntimeCore(client);

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
        { role: "system", content: "You are the core." },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("merges leading system context with the agent system prompt", async () => {
    const client = new FakeChatClient();
    const core = new AgentRuntimeCore(client);

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
        content: "You are the core.\n\n[Memory Scope Capabilities]\n- 可读取 scope: session",
      },
      { role: "user", content: "hello" },
    ]);
  });

  it("emits provider-stream events without depending on backend session state", async () => {
    const client = new FakeStreamingChatClient();
    const core = new AgentRuntimeCore(client);
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
      {
        type: "runtime.done",
        data: {
          content: "hello core",
          agent_name: "orchestrator_agent",
          finish_reason: null,
        },
      },
    ]);
  });

  it("runs a non-streaming tool-call loop through the runtime tool executor", async () => {
    const client = new FakeToolCallingChatClient([
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
        content: "I used the session memory index.",
        finishReason: "stop",
      },
    ]);
    const tools = new FakeRuntimeToolExecutor();
    const core = new AgentRuntimeCore(client);
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
        currentAgentName: "orchestrator_agent",
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
    expect(client.requests[0]?.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "list_memory_index" }),
      }),
    ]);
    expect(tools.calls).toMatchObject([
      {
        call: {
          toolName: "list_memory_index",
          arguments: { scope: "session" },
          callId: "call_memory_1",
        },
        context: {
          sessionId: "s1",
          currentAgentName: "orchestrator_agent",
        },
      },
    ]);
    expect(client.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            expect.objectContaining({
              id: "call_memory_1",
              function: expect.objectContaining({ name: "list_memory_index" }),
            }),
          ],
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_memory_1",
          name: "list_memory_index",
          content: expect.stringContaining("# Session Memory"),
        }),
      ]),
    );
    expect(events).toEqual([
      {
        type: "runtime.tool_call",
        data: {
          agent_name: "orchestrator_agent",
          tool_call_id: "call_memory_1",
          tool_name: "list_memory_index",
          round: 0,
        },
      },
      {
        type: "runtime.tool_result",
        data: {
          agent_name: "orchestrator_agent",
          tool_call_id: "call_memory_1",
          tool_name: "list_memory_index",
          success: true,
          summary: "已读取 session MEMORY 索引",
        },
      },
      {
        type: "runtime.done",
        data: {
          content: "I used the session memory index.",
          agent_name: "orchestrator_agent",
          finish_reason: "stop",
        },
      },
    ]);
  });

  it("emits a runtime error event before rethrowing provider failures", async () => {
    const client = new FakeChatClient(new Error("provider failed"));
    const core = new AgentRuntimeCore(client);
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
