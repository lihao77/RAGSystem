import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { AgentRuntimeCore, type AgentRuntimeCoreEvent } from "../../src/services/agent-runtime-core.js";
import type { ChatCompletionRequest, LlmChatClient } from "../../src/services/llm-chat-client.js";

class FakeChatClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  async complete(request: ChatCompletionRequest) {
    this.requests.push(request);
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

    expect(result).toEqual({ content: "core answer" });
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

  it("emits provider-stream events without depending on backend session state", async () => {
    const client = new FakeStreamingChatClient();
    const core = new AgentRuntimeCore(client);
    const events: AgentRuntimeCoreEvent[] = [];

    const result = await core.runText({
      agent: minimalAgent(),
      provider: minimalProvider(),
      modelName: "deepseek-chat",
      conversation: [{ role: "user", content: "stream" }],
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toEqual({ content: "hello core" });
    expect(events).toEqual([
      {
        type: "llm.first_token",
        data: {
          elapsed_ms: expect.any(Number),
          agent_name: "orchestrator_agent",
        },
      },
      {
        type: "output.chunk",
        data: {
          content: "hello ",
          agent_name: "orchestrator_agent",
        },
      },
      {
        type: "output.chunk",
        data: {
          content: "core",
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
