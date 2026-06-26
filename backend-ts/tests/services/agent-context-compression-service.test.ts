import { describe, expect, it } from "vitest";

import type { AgentConfig, AgentLlmConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import {
  resolveContextBudget,
  resolveContextCompressionSettings,
} from "../../src/services/agent/context-compression/index.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import { SdkStoreAdapter } from "../../src/services/agent/sdk/sdk-store-adapter.js";
import { projectAgentProfile } from "../../src/services/agent/sdk/projection.js";
import { compactSession, AgentContextCompressionService, type LlmClient, type LlmRequest } from "@ragsystem/agent-sdk";
import { SystemConfigService } from "../../src/services/config/system-config-service.js";

class FakeSummaryClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly failingProviders: Set<string>;

  constructor(failingProviders: Iterable<string> = []) {
    this.failingProviders = new Set(failingProviders);
  }

  async complete(request: LlmRequest) {
    this.requests.push(request);
    if (this.failingProviders.has(request.provider.name)) {
      throw new Error(`provider ${request.provider.name} unavailable`);
    }
    return { content: "<analysis>draft</analysis><summary>压缩后的关键上下文</summary>" };
  }
}

describe("resolveContextBudget (pure)", () => {
  it("computes context budget from system config and agent context window", () => {
    const systemConfig = new SystemConfigService();
    systemConfig.updateConfig({
      context: {
        compression_trigger_ratio: 0.75,
        summarize_max_tokens: 64,
        preserve_recent_turns: 1,
        system_prompt_reserve: 0,
        min_context_budget: 10,
      },
    });
    // 1000 窗口 − 0 reserve − 100 completion = 900，×0.9 safety = 810？否：budget = floor(1000*0.9) − 0 − 100 = 800。
    expect(
      resolveContextBudget(minimalAgent({ maxContextTokens: 1000, maxCompletionTokens: 100 }), provider(), systemConfig.getConfig(), "deepseek-chat"),
    ).toBe(800);
    expect(resolveContextCompressionSettings(minimalAgent(), systemConfig.getConfig()).compressionTriggerRatio).toBe(0.75);
  });

  it("reserves the selected model's own max_completion_tokens in the budget", () => {
    const systemConfig = new SystemConfigService();
    systemConfig.updateConfig({
      context: {
        compression_trigger_ratio: 0.85,
        summarize_max_tokens: 64,
        preserve_recent_turns: 3,
        system_prompt_reserve: 0,
        min_context_budget: 10,
      },
    });
    // agent 默认层 max_completion=100；provider 自带 200，agent 值优先 → budget 扣 100。
    // budget = floor(1000*0.9) − 0 reserve − 100 = 800。
    const agent = minimalAgent({ maxContextTokens: 1000, maxCompletionTokens: 100 });
    const budget = resolveContextBudget(agent, provider({ maxCompletionTokens: 200 }), systemConfig.getConfig(), "deepseek-chat");
    expect(budget).toBe(800);
  });
});

describe("compactSession (SDK 入口)", () => {
  it("force-compacts history into a summary message via the shared SDK executor", async () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    try {
      store.createSession("s1");
      // 播种 >preserveRecentTurns*2 条消息，让 selectCompressibleSegment 能切出可压缩段。
      for (const [index, content] of ["旧消息一", "旧消息二", "旧消息三", "旧消息四", "旧消息五", "旧消息六", "旧消息七", "旧消息八"].entries()) {
        store.addMessage({ sessionId: "s1", role: index % 2 === 0 ? "user" : "assistant", content: content.repeat(12) });
      }

      const chatClient = new FakeSummaryClient();
      const profile = projectAgentProfile({ agent: minimalAgent(), providers: [provider()] });
      const sdkStore = new SdkStoreAdapter({ conversationStore: store });

      const result = await compactSession({ sessionId: "s1", store: sdkStore, profile, llm: chatClient });

      expect(result.status).toBe("success");
      expect(result.replacedMessageCount).toBeGreaterThan(0);
      expect(chatClient.requests).toHaveLength(1);
      // 摘要已写回同一 message 表。
      const messages = sdkStore.listMessages("s1", "root", 100);
      expect(messages.some((message) => Boolean(message.metadata?.compression))).toBe(true);
    } finally {
      store.close();
    }
  });

  it("skips when there are not enough messages to replace", async () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    try {
      store.createSession("s1");
      store.addMessage({ sessionId: "s1", role: "user", content: "只有一条" });

      const chatClient = new FakeSummaryClient();
      const profile = projectAgentProfile({ agent: minimalAgent(), providers: [provider()] });
      const sdkStore = new SdkStoreAdapter({ conversationStore: store });

      const result = await compactSession({ sessionId: "s1", store: sdkStore, profile, llm: chatClient });

      expect(result.status).toBe("skipped");
      expect(chatClient.requests).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

describe("AgentContextCompressionService.summarizeSegment tier fallback (SDK 执行体)", () => {
  it("falls back to default when the fast tier provider fails", async () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    try {
      const chatClient = new FakeSummaryClient(["fast-prov"]);
      const fastProvider = makeProvider("fast-prov", "openai", "fast-model");
      const defaultProvider = provider();
      const profile = projectAgentProfile({
        agent: minimalAgent({ fastTier: { provider: "fast-prov", provider_type: "openai", model_name: "fast-model", extra_params: {} } }),
        providers: [fastProvider, defaultProvider],
      });
      const service = new AgentContextCompressionService({
        store: new SdkStoreAdapter({ conversationStore: store }),
        llm: chatClient,
        profile,
      });

      const result = await service.summarizeSegment({
        segment: [{ role: "user", content: "x" }],
        existingSummary: "",
        maxTokens: 64,
      });

      expect(result).toContain("压缩后的关键上下文");
      expect(chatClient.requests.map((request) => request.provider.name)).toEqual(["fast-prov", "my"]);
    } finally {
      store.close();
    }
  });

  it("returns null (no truncation) when all tiers fail", async () => {
    const store = createConversationStore({ dbPath: ":memory:" });
    try {
      const chatClient = new FakeSummaryClient(["my"]);
      const profile = projectAgentProfile({ agent: minimalAgent(), providers: [provider()] });
      const service = new AgentContextCompressionService({
        store: new SdkStoreAdapter({ conversationStore: store }),
        llm: chatClient,
        profile,
      });

      const result = await service.summarizeSegment({
        segment: [{ role: "user", content: "x" }],
        existingSummary: "",
        maxTokens: 64,
      });

      expect(result).toBeNull();
    } finally {
      store.close();
    }
  });
});

function minimalAgent(input: {
  maxContextTokens?: number;
  maxCompletionTokens?: number;
  fastTier?: AgentLlmConfig;
} = {}): AgentConfig {
  const llmTiers: Record<string, AgentLlmConfig> = {
    default: {
      provider: "my",
      provider_type: "deepseek",
      model_name: "deepseek-chat",
      max_context_tokens: input.maxContextTokens ?? 128000,
      max_completion_tokens: input.maxCompletionTokens ?? 4096,
      extra_params: {},
    },
  };
  if (input.fastTier) {
    llmTiers.fast = input.fastTier;
  }
  return {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator",
    description: null,
    enabled: true,
    default_entry: true,
    llm_tiers: llmTiers,
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

function provider(overrides: { maxCompletionTokens?: number } = {}): ModelProviderConfig {
  return {
    name: "my",
    key: "my_deepseek",
    provider_type: "deepseek",
    api_key: "sk-test",
    models: ["deepseek-chat"],
    model_map: { chat: "deepseek-chat" },
    ...(overrides.maxCompletionTokens !== undefined ? { max_completion_tokens: overrides.maxCompletionTokens } : {}),
  };
}

function makeProvider(name: string, providerType: string, chatModel: string): ModelProviderConfig {
  return {
    name,
    key: `${name}_${providerType}`,
    provider_type: providerType,
    api_key: "sk-test",
    models: [chatModel],
    model_map: { chat: chatModel },
  };
}
