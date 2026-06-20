import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { AgentContextCompressionService } from "../../src/services/agent/context-compression/index.js";
import { AgentContextService } from "../../src/services/agent/context/index.js";
import {
  AgentRuntimeContextBuilder,
  RecentMessagesContextSource,
  resolveCompressionView,
} from "../../src/services/agent/context-builder/index.js";
import { createConversationStore } from "../../src/services/stores/conversation-store/index.js";
import type { ChatCompletionRequest, LlmChatClient } from "../../src/services/integrations/llm-chat-client.js";
import { SystemConfigService } from "../../src/services/config/system-config-service.js";

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
    store = createConversationStore({ dbPath: ":memory:" });
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
    const service = new AgentContextCompressionService(store, chatClient, systemConfig);

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
    const service = new AgentContextCompressionService(store, chatClient, new SystemConfigService());
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

describe("AgentContextService.recompact (micro-first)", () => {
  it("microcompacts away the overflow without invoking LLM compression", async () => {
    const { service, chatClient } = buildFacade();
    // 8 条大 observation（每条 120 token）超阈值；microcompact 裁掉最旧 3 条后落回阈值下。
    seedObservations("micro-only", 8, "数据".repeat(60));

    const rebuilt = await service.recompact(recompactInput("micro-only"));

    expect(chatClient.requests).toHaveLength(0); // 未触发 LLM 压缩
    expect(rebuilt).not.toBeNull();
    expect(rebuilt?.some((message) => message.content.startsWith("[工具结果已清理"))).toBe(true);
    expect(store?.listMessages("micro-only", 50, 0, "root").items.find((message) => message.metadata.compression)).toBeUndefined();
  });

  it("falls through to LLM compression when microcompact alone stays over threshold", async () => {
    const { service, chatClient } = buildFacade();
    // observation 巨大（每条 300 token），裁掉最旧 3 条后仍远超阈值 → 走 compressIfNeeded。
    seedObservations("still-over", 8, "数据".repeat(150));

    const rebuilt = await service.recompact(recompactInput("still-over"));

    expect(chatClient.requests).toHaveLength(1); // 触发 LLM 压缩
    expect(rebuilt).not.toBeNull();
    expect(store?.listMessages("still-over", 50, 0, "root").items.find((message) => message.metadata.compression)).toMatchObject({
      metadata: expect.objectContaining({ compression: true, compression_strategy: "llm_summarize" }),
    });
  });

  it("returns null when the microcompact gate is fresh and tokens are under threshold", async () => {
    const { service, chatClient } = buildFacade();
    seedObservations("fresh", 2, "短"); // 极小，远低于阈值
    // 注入鲜活缓存：指纹与默认 no_stable_prefix 一致、时间在 TTL(600s) 内 → 门控判定不裁剪。
    store?.updateSessionMetadata("fresh", {
      _pipeline_caches: { root: { fp: "no_stable_prefix", t: Date.now() / 1000 } },
    });

    const rebuilt = await service.recompact(recompactInput("fresh"));

    expect(rebuilt).toBeNull(); // 无裁剪、未压缩 → 不替换工作副本
    expect(chatClient.requests).toHaveLength(0);
  });
});

function buildFacade(): { service: AgentContextService; chatClient: FakeSummaryClient } {
  store = createConversationStore({ dbPath: ":memory:" });
  const systemConfig = new SystemConfigService();
  systemConfig.updateConfig({
    context: {
      compression_trigger_ratio: 0.8,
      summarize_max_tokens: 64,
      preserve_recent_turns: 1,
      system_prompt_reserve: 0,
      min_context_budget: 1000,
    },
  });
  const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(store)], {
    systemConfig: { getConfig: () => ({ waiting: { local_cache_ttl_seconds: 600 } }) },
  });
  const chatClient = new FakeSummaryClient();
  const compression = new AgentContextCompressionService(store, chatClient, systemConfig);
  const service = new AgentContextService(builder, compression, systemConfig);
  return { service, chatClient };
}

// 预算（agent maxContextTokens=100 → 钳到 min_context_budget=1000）* ratio 0.8 → 阈值 800。
function seedObservations(sessionId: string, observationCount: number, observationContent: string): void {
  store?.createSession(sessionId);
  store?.addMessage({ sessionId, role: "user", content: "开始任务" });
  for (let round = 1; round <= observationCount; round += 1) {
    store?.addMessage({
      sessionId,
      role: "user",
      content: observationContent,
      metadata: { react_intermediate: true, msg_type: "observation", round },
    });
  }
  store?.addMessage({ sessionId, role: "assistant", content: "最终回答" });
}

function recompactInput(sessionId: string) {
  return {
    sessionId,
    agent: minimalAgent({ maxContextTokens: 100, maxCompletionTokens: 1 }),
    provider: provider(),
    modelName: "deepseek-chat",
    runId: "run-1",
    taskId: "task-1",
    requestId: "req-1",
  };
}

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
