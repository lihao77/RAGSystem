import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig, AgentLlmConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { AgentContextCompressionService } from "../../src/services/agent/context-compression/index.js";
import type { RuntimeModelProviderPort } from "../../src/services/agent/execution/runtime-core-service.js";
import {
  AgentContextBuilder,
  RecentMessagesContextSource,
  resolveCompressionView,
} from "../../src/services/agent/context-builder/index.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import type { LlmRequest, LlmClient } from "@ragsystem/agent-llm";
import { SystemConfigService } from "../../src/services/config/system-config-service.js";

let store: ConversationStore | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

class FakeSummaryClient implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly failingProviders: Set<string>;

  constructor(failingProviders: Iterable<string> = []) {
    this.failingProviders = new Set(failingProviders);
  }

  async complete(request: LlmRequest) {
    this.requests.push(request);
    if (request.signal?.aborted) {
      throw new Error("aborted");
    }
    if (this.failingProviders.has(request.provider.name)) {
      throw new Error(`provider ${request.provider.name} unavailable`);
    }
    return { content: "<analysis>draft</analysis><summary>压缩后的关键上下文</summary>" };
  }
}

describe("AgentContextCompressionService", () => {
  it("computes context budget from system config and agent context window", () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const systemConfig = new SystemConfigService();
    systemConfig.updateConfig({
      context: {
        system_prompt_reserve: 100,
        min_context_budget: 50,
        compression_trigger_ratio: 0.75,
      },
    });
    const service = new AgentContextCompressionService(store, new FakeSummaryClient(), systemConfig, providerPort([provider()]));

    expect(service.resolveContextBudget(minimalAgent({ maxContextTokens: 1000, maxCompletionTokens: 100 }), provider(), "deepseek-chat")).toBe(700);
    expect(service.resolveContextSettings(minimalAgent()).compressionTriggerRatio).toBe(0.75);
  });

  it("reserves the selected model's own max_completion_tokens in the budget", () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const systemConfig = new SystemConfigService();
    systemConfig.updateConfig({
      context: { system_prompt_reserve: 100, min_context_budget: 50, compression_trigger_ratio: 0.75 },
    });
    const service = new AgentContextCompressionService(store, new FakeSummaryClient(), systemConfig, providerPort([provider()]));
    // 默认层窗口 1000 / 补全 100；但运行经 selectedLlm 选中 sel-model，其 provider 补全=300。
    // 预算用选中模型的补全预留：floor(1000*0.9) - 100(reserve) - 300 = 500（而非默认层的 700）。
    const selected = { ...makeProvider("sel-prov", "openai", "sel-model"), max_completion_tokens: 300 };
    const budget = service.resolveContextBudget(
      minimalAgent({ maxContextTokens: 1000, maxCompletionTokens: 100 }),
      selected,
      "sel-model",
    );
    expect(budget).toBe(500);
  });

  it("uses fast-tier temperature and extra_params for the summary request", async () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const systemConfig = new SystemConfigService();
    const chatClient = new FakeSummaryClient();
    const service = new AgentContextCompressionService(store, chatClient, systemConfig, providerPort([provider()]));
    const agent = minimalAgent({ maxContextTokens: 1000, maxCompletionTokens: 100 });
    agent.llm_tiers!.fast = {
      provider: "my",
      provider_type: "deepseek",
      model_name: "deepseek-chat",
      temperature: 0.1,
      max_completion_tokens: 64,
      extra_params: { top_p: 0.8 },
    } as AgentLlmConfig;
    await service.summarizeSegment({
      agent,
      provider: provider(),
      modelName: "deepseek-chat",
      segment: [{ role: "user", content: "待压缩内容" }],
      existingSummary: "",
      maxTokens: 64,
    });
    expect(chatClient.requests[0]).toMatchObject({ temperature: 0.1, maxCompletionTokens: 64 });
    expect(chatClient.requests[0].extraParams).toEqual({ top_p: 0.8 });
  });

  it("persists Python-compatible compression summaries and exposes the resolved view", async () => {
    store = createConversationStore({ dbPath: ":memory:" });
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
    const service = new AgentContextCompressionService(store, chatClient, systemConfig, providerPort([provider()]));

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
    // temperature 走三级 fallback：agent 未配 fast/default temperature → system 默认(0.7)。
    expect(chatClient.requests[0]).toMatchObject({
      maxCompletionTokens: 64,
      temperature: 0.7,
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

  it("force compacts a session regardless of token threshold", async () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const systemConfig = new SystemConfigService();
    systemConfig.updateConfig({
      context: {
        compression_trigger_ratio: 0.99,
        summarize_max_tokens: 32,
        preserve_recent_turns: 1,
        system_prompt_reserve: 0,
        min_context_budget: 10,
      },
    });
    const chatClient = new FakeSummaryClient();
    const service = new AgentContextCompressionService(store, chatClient, systemConfig, providerPort([provider()]));

    store.createSession("force-s1");
    for (const [role, content] of [
      ["user", "old user"],
      ["assistant", "old assistant"],
      ["user", "tail user"],
      ["assistant", "tail assistant"],
    ] as const) {
      store.addMessage({ sessionId: "force-s1", role, content });
    }

    const result = await service.forceCompactSession({
      sessionId: "force-s1",
      agent: minimalAgent({ maxContextTokens: 100000, maxCompletionTokens: 1 }),
      provider: provider(),
      modelName: "deepseek-chat",
      requestId: "req-force",
    });

    expect(result).toMatchObject({
      status: "success",
      reason: "success",
      before: 4,
      replaced_message_count: 2,
      replaces_up_to_seq: 2,
      summary_content: expect.stringContaining("压缩后的关键上下文"),
      summary_message_id: expect.any(String),
    });
    expect(chatClient.requests).toHaveLength(1);
    const messages = store.listMessages("force-s1", 20, 0, "root").items;
    expect(messages.find((message) => message.metadata.compression)).toMatchObject({
      metadata: expect.objectContaining({
        forced: true,
        compression_strategy: "llm_summarize",
      }),
    });
  });

  it("skips force compact when there are not enough messages to replace", async () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const chatClient = new FakeSummaryClient();
    const service = new AgentContextCompressionService(store, chatClient, new SystemConfigService(), providerPort([provider()]));
    store.createSession("force-skip");
    store.addMessage({ sessionId: "force-skip", role: "user", content: "only tail" });

    await expect(
      service.forceCompactSession({
        sessionId: "force-skip",
        agent: minimalAgent(),
        provider: provider(),
        modelName: "deepseek-chat",
      }),
    ).resolves.toMatchObject({
      status: "skipped",
      reason: "insufficient_candidates",
      before: 1,
      after: 1,
      tokens_saved: 0,
    });
    expect(chatClient.requests).toHaveLength(0);
  });
});

describe("AgentContextCompressionService tier fallback", () => {
  it("falls back to default when the fast tier provider fails", async () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const chatClient = new FakeSummaryClient(["fast-prov"]);
    const service = new AgentContextCompressionService(
      store,
      chatClient,
      new SystemConfigService(),
      providerPort([makeProvider("fast-prov", "deepseek", "fast-model"), provider()]),
    );
    const agent = minimalAgent({
      fastTier: {
        provider: "fast-prov",
        provider_type: "deepseek",
        model_name: "fast-model",
        max_completion_tokens: 64,
        extra_params: {},
      },
    });

    const result = await service.summarizeSegment({
      agent,
      provider: provider(),
      modelName: "deepseek-chat",
      segment: [
        { role: "user", content: "旧消息一" },
        { role: "assistant", content: "旧回复一" },
      ],
      existingSummary: "",
      maxTokens: 64,
    });

    expect(chatClient.requests).toHaveLength(2);
    expect(chatClient.requests[0].provider.name).toBe("fast-prov");
    expect(chatClient.requests[1].provider.name).toBe("my");
    expect(result).toContain("压缩后的关键上下文");
  });

  it("dedupes fast and default pointing to the same model (tries once)", async () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const chatClient = new FakeSummaryClient();
    const service = new AgentContextCompressionService(
      store,
      chatClient,
      new SystemConfigService(),
      providerPort([provider()]),
    );
    const agent = minimalAgent({
      fastTier: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        max_completion_tokens: 64,
        extra_params: {},
      },
    });

    const result = await service.summarizeSegment({
      agent,
      provider: provider(),
      modelName: "deepseek-chat",
      segment: [{ role: "user", content: "x" }],
      existingSummary: "",
      maxTokens: 64,
    });

    expect(result).toContain("压缩后的关键上下文");
    expect(chatClient.requests).toHaveLength(1);
  });

  it("returns null (no truncation) when all tiers fail", async () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const chatClient = new FakeSummaryClient(["my"]);
    const service = new AgentContextCompressionService(
      store,
      chatClient,
      new SystemConfigService(),
      providerPort([provider()]),
    );

    const result = await service.summarizeSegment({
      agent: minimalAgent(),
      provider: provider(),
      modelName: "deepseek-chat",
      segment: [
        { role: "user", content: "x" },
        { role: "assistant", content: "y" },
      ],
      existingSummary: "",
      maxTokens: 64,
    });

    expect(result).toBeNull();
  });

  it("uses the passed default model (selectedLlm override) instead of llm_tiers.default", async () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const chatClient = new FakeSummaryClient();
    const selected = makeProvider("sel-prov", "openai", "sel-model");
    const service = new AgentContextCompressionService(
      store,
      chatClient,
      new SystemConfigService(),
      providerPort([selected, provider()]),
    );

    // agent.llm_tiers.default 指向 "my"，但运行经 selectedLlm 解析为 sel-prov；
    // fast 未配置 → 回落到 default(= 传入的 sel-prov)，摘要应打到 sel-prov 而非 "my"。
    const result = await service.summarizeSegment({
      agent: minimalAgent(),
      provider: selected,
      modelName: "sel-model",
      segment: [{ role: "user", content: "x" }],
      existingSummary: "",
      maxTokens: 64,
    });

    expect(result).toContain("压缩后的关键上下文");
    expect(chatClient.requests).toHaveLength(1);
    expect(chatClient.requests[0].provider.name).toBe("sel-prov");
    expect(chatClient.requests[0].model).toBe("sel-model");
  });

  it("propagates abort without falling back", async () => {
    store = createConversationStore({ dbPath: ":memory:" });
    const chatClient = new FakeSummaryClient();
    const service = new AgentContextCompressionService(
      store,
      chatClient,
      new SystemConfigService(),
      providerPort([provider()]),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.summarizeSegment({
        agent: minimalAgent(),
        provider: provider(),
        modelName: "deepseek-chat",
        segment: [{ role: "user", content: "x" }],
        existingSummary: "",
        maxTokens: 64,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(chatClient.requests).toHaveLength(1);
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

function providerPort(providers: ModelProviderConfig[]): RuntimeModelProviderPort {
  return { listProviders: () => providers };
}
