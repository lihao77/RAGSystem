import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { AgentContextCompressionService } from "../../src/services/agent-context-compression-service.js";
import { resolveCompressionView } from "../../src/services/agent-runtime-context-builder.js";
import { ConversationStore } from "../../src/services/conversation-store.js";
import type { ChatCompletionRequest, LlmChatClient } from "../../src/services/llm-chat-client.js";
import { SystemConfigService } from "../../src/services/system-config-service.js";

let store: ConversationStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

class FakeSummaryClient implements LlmChatClient {
  readonly requests: ChatCompletionRequest[] = [];

  async complete(request: ChatCompletionRequest) {
    this.requests.push(request);
    return { content: "<analysis>draft</analysis><summary>压缩后的关键上下文</summary>" };
  }
}

describe("AgentContextCompressionService", () => {
  it("computes context budget from system config and agent context window", () => {
    store = new ConversationStore({ dbPath: ":memory:" });
    const systemConfig = new SystemConfigService();
    systemConfig.updateConfig({
      context: {
        system_prompt_reserve: 100,
        min_context_budget: 50,
        compression_trigger_ratio: 0.75,
      },
    });
    const service = new AgentContextCompressionService(store, new FakeSummaryClient(), systemConfig);

    expect(service.resolveContextBudget(minimalAgent({ maxContextTokens: 1000, maxCompletionTokens: 100 }), provider())).toBe(700);
    expect(service.resolveContextSettings(minimalAgent()).compressionTriggerRatio).toBe(0.75);
  });

  it("persists Python-compatible compression summaries and exposes the resolved view", async () => {
    store = new ConversationStore({ dbPath: ":memory:" });
    const systemConfig = new SystemConfigService();
    systemConfig.updateConfig({
      context: {
        compression_trigger_ratio: 0.5,
        summarize_max_tokens: 64,
        preserve_recent_turns: 1,
        system_prompt_reserve: 0,
        min_context_budget: 10,
      },
    });
    const chatClient = new FakeSummaryClient();
    const service = new AgentContextCompressionService(store, chatClient, systemConfig);

    store.createSession("s1");
    for (const [role, content] of [
      ["user", "旧用户消息一".repeat(12)],
      ["assistant", "旧助手消息一".repeat(12)],
      ["user", "旧用户消息二".repeat(12)],
      ["assistant", "需要保留的助手消息".repeat(12)],
      ["user", "需要保留的用户消息".repeat(12)],
    ] as const) {
      store.addMessage({ sessionId: "s1", role, content });
    }

    const events: string[] = [];
    const result = await service.compressIfNeeded({
      sessionId: "s1",
      runId: "run-1",
      taskId: "task-1",
      requestId: "req-1",
      agent: minimalAgent({ maxContextTokens: 100, maxCompletionTokens: 1 }),
      provider: provider(),
      modelName: "deepseek-chat",
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    expect(result).toMatchObject({
      status: "success",
      reason: "success",
      replacedMessageCount: 3,
      replacesUpToSeq: 3,
    });
    expect(chatClient.requests).toHaveLength(1);
    expect(chatClient.requests[0]).toMatchObject({
      maxCompletionTokens: 64,
      temperature: 0.2,
    });
    expect(events).toEqual(["context.compression_start", "context.compression_summary"]);

    const messages = store.listMessages("s1", 20, 0, "root").items;
    const summary = messages.find((message) => message.metadata.compression);
    expect(summary).toMatchObject({
      role: "assistant",
      content: expect.stringContaining("压缩后的关键上下文"),
      metadata: expect.objectContaining({
        compression: true,
        replaces_up_to_seq: 3,
        compression_strategy: "llm_summarize",
      }),
    });
    expect(resolveCompressionView(messages).map((message) => message.content)).toEqual([
      expect.stringContaining("压缩后的关键上下文"),
      "需要保留的助手消息".repeat(12),
      "需要保留的用户消息".repeat(12),
    ]);
  });
});

function minimalAgent(input: { maxContextTokens?: number; maxCompletionTokens?: number } = {}): AgentConfig {
  return {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator",
    description: null,
    enabled: true,
    default_entry: true,
    llm_tiers: {
      default: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        max_context_tokens: input.maxContextTokens ?? 128000,
        max_completion_tokens: input.maxCompletionTokens ?? 4096,
        extra_params: {},
      },
    },
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: ["session"],
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
        system_prompt: "你是测试智能体。",
      },
    },
  };
}

function provider(): ModelProviderConfig {
  return {
    name: "my",
    key: "my_deepseek",
    provider_type: "deepseek",
    api_key: "sk-test",
    models: ["deepseek-chat"],
    model_map: { chat: "deepseek-chat" },
  };
}
