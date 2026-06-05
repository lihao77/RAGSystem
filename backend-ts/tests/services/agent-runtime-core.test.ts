import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { AgentRuntimeCore, type AgentRuntimeEvent } from "../../src/services/agent-runtime-core.js";
import type { ChatCompletionRequest, ChatCompletionResult, LlmChatClient } from "../../src/services/llm-chat-client.js";
import { renderToolResultContent } from "../../src/services/runtime-xml-protocol.js";
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
        { role: "system", content: expect.stringContaining("<system_instruction") },
        { role: "user", content: expect.stringContaining("<user_input") },
      ],
    });
    expect(client.requests[0]?.messages[0]?.content).toContain("You are the core.");
    expect(client.requests[0]?.messages[1]?.content).toContain("hello");
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
        content: expect.stringContaining("<context source=\"memory\">"),
      },
      { role: "user", content: expect.stringContaining("<user_input") },
    ]);
    expect(client.requests[0]?.messages[0]?.content).toContain("You are the core.");
    expect(client.requests[0]?.messages[0]?.content).toContain("[Memory Scope Capabilities]");
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
    expect(client.requests[0]?.tools).toBeUndefined();
    expect(client.requests[0]?.toolChoice).toBeUndefined();
    expect(client.requests[0]?.messages[0]?.content).toContain("<runtime_instruction");
    expect(client.requests[0]?.messages[0]?.content).toContain("<tool_manifest>");
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
          type: "runtime.tool_call",
          data: expect.objectContaining({ tool_name: "list_memory_index" }),
        }),
        expect.objectContaining({
          type: "runtime.tool_result",
          data: expect.objectContaining({ success: true }),
        }),
        expect.objectContaining({
          type: "runtime.output_delta",
          data: expect.objectContaining({ content: "I used the session memory index." }),
        }),
        expect.objectContaining({
          type: "runtime.done",
          data: expect.objectContaining({ content: "I used the session memory index." }),
        }),
      ]),
    );
  });

  it("feeds protocol feedback back to the model when XML tool calls are malformed", async () => {
    const client = new FakeXmlStreamingToolChatClient([
      ["<tool_calls>not a tool</tool_calls>"],
      ["<final_answer>repaired answer</final_answer>"],
    ]);
    const tools = new FakeRuntimeToolExecutor();
    const core = new AgentRuntimeCore(client);
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
        currentAgentName: "orchestrator_agent",
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
    const nativeToolResultMessage = client.requests[1]?.messages.find((message) => message.role === "tool");
    expect(nativeToolResultMessage?.content).toContain('id="call_memory_1"');
    expect(nativeToolResultMessage?.content).toContain('ok="true"');
    expect(nativeToolResultMessage?.content).toContain("# Session Memory");
    expect(nativeToolResultMessage?.content).not.toContain('"artifacts"');
    expect(events).toEqual([
      {
        type: "runtime.tool_call",
        data: {
          agent_name: "orchestrator_agent",
          tool_call_id: "call_memory_1",
          tool_name: "list_memory_index",
          arguments: { scope: "session" },
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
