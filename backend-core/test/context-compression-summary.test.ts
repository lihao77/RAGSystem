import { describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest } from "@ragsystem/agent-llm";

import type { ISystemConfigStore } from "../src/contracts/runtime/system-config-store.js";
import type { SystemConfigData } from "../src/contracts/runtime/system-config.js";
import { SystemConfigService } from "../src/services/config/system-config-service.js";
import { AgentCompressionService, type CompressionLogger } from "../src/services/agent/context-compression/compression-service.js";
import type { AgentConfig } from "../src/contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";
import type { CompressionHistoryPort, InsertCompressionMessageInput } from "../src/contracts/runtime/core-runtime-ports.js";
import type { MessageInfo } from "../src/contracts/session/session.js";

class MemorySystemConfigStore implements ISystemConfigStore {
  constructor(private value: SystemConfigData | null = null) {}

  async load(): Promise<SystemConfigData | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(config: SystemConfigData): Promise<void> {
    this.value = structuredClone(config);
  }
}

const PROVIDERS: ModelProviderConfig[] = [
  {
    key: "pqy",
    name: "pqy",
    provider_type: "zhipuai",
    api_format: "anthropic",
    api_key: "sk-test",
    models: [{ name: "glm-test" }],
  },
];

function buildAgent(overrides: Record<string, unknown> = {}): AgentConfig {
  return {
    agent_name: "comp_agent",
    enabled: true,
    default_entry: true,
    llm_tiers: {
      default: {
        provider: "pqy",
        provider_type: "zhipuai",
        model_name: "glm-test",
        max_context_tokens: 200000,
        max_completion_tokens: 131072,
        extra_params: {},
      },
    },
    tools: { enabled_tools: [] },
    goals: { enabled: false },
    tasks: { background: false },
    delegation: { enabled_agents: [], parallel_children: false },
    custom_params: {},
    ...overrides,
  } as AgentConfig;
}

/** 20 条 ~3000 token 的消息：保留区走满 6 条/8000 token 下限后仍有可压缩段。 */
function buildHistoryMessages(count = 20): MessageInfo[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    seq: index + 1,
    session_id: "session-1",
    role: index % 2 === 0 ? "user" : "assistant",
    content_parts: [{ type: "text", text: `消息${index}。`.padEnd(3000, "内容") }],
    metadata: {},
    created_at: "2026-09-02T00:00:00Z",
    thread_key: "root",
    child_agent_id: null,
  }));
}

function buildHistoryPort(messageCount = 20): CompressionHistoryPort & { inserted: InsertCompressionMessageInput[] } {
  const port = {
    inserted: [] as InsertCompressionMessageInput[],
    async getRecentMessages(): Promise<MessageInfo[]> {
      return buildHistoryMessages(messageCount);
    },
    async insertCompressionMessage(input: InsertCompressionMessageInput): Promise<MessageInfo> {
      port.inserted.push(input);
      return {
        id: "summary-msg",
        seq: 21,
        session_id: input.sessionId,
        role: "assistant",
        content_parts: [{ type: "text", text: input.summaryContent }],
        metadata: input.metadata ?? {},
        created_at: "2026-09-02T00:00:00Z",
        thread_key: input.threadKey ?? "root",
        child_agent_id: null,
      };
    },
  };
  return port;
}

async function buildSystemConfig(persisted: SystemConfigData | null): Promise<SystemConfigService> {
  const service = new SystemConfigService(new MemorySystemConfigStore(persisted));
  await service.initialize();
  return service;
}

const COMPACT_INPUT = {
  sessionId: "session-1",
  systemPromptTokens: 100,
};

describe("compression summary request hardening", () => {
  it("disables thinking and uses the tier max_completion_tokens even with stale config remnants", async () => {
    // 事故残留：持久化配置里旧键 summarize_max_tokens:300 不再被读取（设置已整体退役），
    // 摘要输出上限直接取 tier 的 max_completion_tokens。
    const systemConfig = await buildSystemConfig({ context: { summarize_max_tokens: 300 } });
    const requests: LlmRequest[] = [];
    const llm: LlmClient = {
      async complete(request) {
        requests.push(structuredClone(request));
        return { content: "<summary>要点</summary>" };
      },
    };
    const history = buildHistoryPort();
    const service = new AgentCompressionService(history, () => PROVIDERS, systemConfig, null, llm);

    const result = await service.forceCompact({ ...COMPACT_INPUT, agent: buildAgent() });

    expect(result.status).toBe("success");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.thinkingLevel).toBe("off");
    expect(requests[0]!.maxCompletionTokens).toBe(131072);
    expect(requests[0]!.model).toBe("glm-test");
    expect(history.inserted).toHaveLength(1);
  });

  it("skips with summary_unavailable and logs the underlying error when the model returns empty content", async () => {
    const systemConfig = await buildSystemConfig(null);
    const llm: LlmClient = {
      async complete() {
        return { content: "" };
      },
    };
    const errors: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    const logger: CompressionLogger = {
      error(bindings, message) {
        errors.push({ bindings, message });
      },
    };
    const service = new AgentCompressionService(buildHistoryPort(), () => PROVIDERS, systemConfig, logger, llm);

    const result = await service.forceCompact({ ...COMPACT_INPUT, agent: buildAgent() });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("summary_unavailable");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.bindings).toMatchObject({ tier: "default", model: "glm-test", provider_key: "pqy" });
    expect(String(errors[0]!.bindings.error)).toContain("empty content");
  });

  it("fires onSummarizeStart exactly once, before the LLM call, only when a segment was selected", async () => {
    const systemConfig = await buildSystemConfig(null);
    const order: string[] = [];
    const llm: LlmClient = {
      async complete() {
        order.push("complete");
        return { content: "<summary>要点</summary>" };
      },
    };
    const service = new AgentCompressionService(buildHistoryPort(), () => PROVIDERS, systemConfig, null, llm);

    const result = await service.forceCompact({
      ...COMPACT_INPUT,
      agent: buildAgent(),
      onSummarizeStart: () => order.push("started"),
    });

    expect(result.status).toBe("success");
    expect(order).toEqual(["started", "complete"]);
  });

  it("does not fire onSummarizeStart when the segment is insufficient (no LLM call ahead)", async () => {
    const systemConfig = await buildSystemConfig(null);
    const llm: LlmClient = {
      async complete() {
        throw new Error("must not be called");
      },
    };
    const service = new AgentCompressionService(buildHistoryPort(2), () => PROVIDERS, systemConfig, null, llm);

    let started = false;
    const result = await service.forceCompact({
      ...COMPACT_INPUT,
      agent: buildAgent(),
      onSummarizeStart: () => {
        started = true;
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("insufficient_candidates");
    expect(started).toBe(false);
  });
});
