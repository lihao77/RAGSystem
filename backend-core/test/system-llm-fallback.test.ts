import { describe, expect, it } from "vitest";

import { AgentConfigSchema, type AgentConfig } from "../src/contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";
import type { ISystemConfigStore } from "../src/contracts/runtime/system-config-store.js";
import type { SystemConfigData, SystemLlmConfig } from "../src/contracts/runtime/system-config.js";
import type { SessionTeamSnapshot } from "../src/contracts/session/session.js";
import {
  RuntimeCoreService,
  type RuntimeAgentConfigPort,
  type RuntimeModelProviderPort,
  type RuntimeSystemConfigPort,
} from "../src/services/agent/execution/runtime-core-service.js";
import { SystemConfigService } from "../src/services/config/system-config-service.js";

class MemorySystemConfigStore implements ISystemConfigStore {
  constructor(private config: SystemConfigData | null = null) {}

  async load(): Promise<SystemConfigData | null> {
    return this.config ? structuredClone(this.config) : null;
  }

  async save(config: SystemConfigData): Promise<void> {
    this.config = structuredClone(config);
  }
}

class MemoryAgentConfigs implements RuntimeAgentConfigPort {
  constructor(readonly configs: Record<string, AgentConfig>) {}

  getConfig(agentName: string): AgentConfig | null {
    return this.configs[agentName] ?? null;
  }

  listConfigs(): Record<string, AgentConfig> {
    return this.configs;
  }
}

class MemoryModelProviders implements RuntimeModelProviderPort {
  listProviders(): ModelProviderConfig[] {
    return [systemProvider()];
  }
}

class MemoryRuntimeSystemConfig implements RuntimeSystemConfigPort {
  getLlmConfig(): SystemLlmConfig {
    return systemLlm();
  }
}

describe("system LLM configuration", () => {
  it("exposes a configurable LLM fallback in the system schema", async () => {
    const service = new SystemConfigService(new MemorySystemConfigStore());
    await service.initialize();

    expect(service.getSchema().groups).toContainEqual(expect.objectContaining({
      key: "llm",
      fields: expect.arrayContaining([
        expect.objectContaining({ key: "provider", type: "text" }),
        expect.objectContaining({ key: "model_name", type: "text" }),
        expect.objectContaining({ key: "temperature", type: "number", min: 0, max: 2 }),
      ]),
    }));
    expect(service.getConfig()).toMatchObject({
      llm: {
        provider: "",
        model_name: "",
        temperature: 0.2,
        max_completion_tokens: 4096,
        max_context_tokens: 128000,
      },
    });
  });

  it("clears stale model fields when no system provider is selected", async () => {
    const service = new SystemConfigService(new MemorySystemConfigStore({
      llm: {
        provider: "",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        max_context_tokens: null,
      },
    }));
    await service.initialize();

    expect(service.getConfig()).toMatchObject({
      llm: { provider: "", provider_type: "", model_name: "" },
    });
    expect(service.getLlmConfig()).toMatchObject({
      provider: "",
      provider_type: "",
      model_name: "",
      max_context_tokens: 128000,
    });
  });

  it("persists updates and returns a normalized runtime fallback", async () => {
    const store = new MemorySystemConfigStore();
    const service = new SystemConfigService(store);
    await service.initialize();

    await service.updateConfig({
      llm: {
        provider: " system ",
        provider_type: " deepseek ",
        model_name: "system-model",
        temperature: 0.25,
        max_completion_tokens: 2048,
      },
    });

    expect(service.getLlmConfig()).toMatchObject({
      provider: "system",
      provider_type: "deepseek",
      model_name: "system-model",
      temperature: 0.25,
      max_completion_tokens: 2048,
    });

    const reloaded = new SystemConfigService(store);
    await reloaded.initialize();
    expect(reloaded.getLlmConfig().model_name).toBe("system-model");
  });
});

describe("RuntimeCoreService system LLM fallback", () => {
  it("uses the system fallback when the agent has no LLM tiers", () => {
    const agent = runtimeAgent();
    const configs = new MemoryAgentConfigs({ agent });
    const service = runtimeCore(configs);

    const resolved = service.resolveExecutionConfig({ agentName: "agent" });

    expect(resolved.readiness).toMatchObject({
      configuration_ready: true,
      llm: {
        provider: "system",
        provider_type: "deepseek",
        model_name: "system-model",
        source: "system_config.llm",
        // 无 tier 继承是常态回落，不标失效。
        fallback_reason: null,
      },
    });
    expect(resolved.agent?.llm_tiers?.default).toMatchObject({
      provider: "system",
      provider_type: "deepseek",
      model_name: "system-model",
      temperature: 0.25,
      max_completion_tokens: 2048,
    });
    expect(agent.llm_tiers).toBeUndefined();
  });

  it("keeps an explicit agent default above the system fallback", () => {
    const agent = runtimeAgent({
      default: {
        provider: "system",
        provider_type: "deepseek",
        model_name: "system-model",
        temperature: 0.1,
        max_completion_tokens: 1024,
        extra_params: {},
      },
    });

    const resolved = runtimeCore(new MemoryAgentConfigs({ agent }))
      .resolveExecutionConfig({ agentName: "agent" });

    expect(resolved.readiness.llm.source).toBe("agent_config.default");
    expect(resolved.readiness.llm.fallback_reason).toBeNull();
    expect(resolved.agent?.llm_tiers?.default?.temperature).toBe(0.1);
  });

  it("falls back to the system LLM when the agent default tier references a deleted provider", () => {
    // provider 已删除/改名：tier 引用按 (name/key, provider_type) 均无法解析（悬空引用）。
    const agent = runtimeAgent({
      default: {
        provider: "deleted-provider",
        provider_type: "deepseek",
        model_name: "deleted-model",
        extra_params: {},
      },
    });

    const resolved = runtimeCore(new MemoryAgentConfigs({ agent }))
      .resolveExecutionConfig({ agentName: "agent" });

    expect(resolved.readiness).toMatchObject({
      configuration_ready: true,
      llm: {
        provider: "system",
        model_name: "system-model",
        source: "system_config.llm",
        fallback_reason: "agent_default_tier_unresolved",
      },
    });
    // 兜底注入不覆盖原配置对象：tier 保留原引用供前端标注失效。
    expect(agent.llm_tiers?.default?.provider).toBe("deleted-provider");
    expect(resolved.agent?.llm_tiers?.default).toMatchObject({ provider: "system", model_name: "system-model" });
  });

  it("falls back when the tier provider resolves but its model is no longer listed", () => {
    const agent = runtimeAgent({
      default: {
        provider: "system",
        provider_type: "deepseek",
        model_name: "retired-model",
        extra_params: {},
      },
    });

    const resolved = runtimeCore(new MemoryAgentConfigs({ agent }))
      .resolveExecutionConfig({ agentName: "agent" });

    expect(resolved.readiness.configuration_ready).toBe(true);
    expect(resolved.readiness.llm).toMatchObject({
      source: "system_config.llm",
      model_name: "system-model",
      fallback_reason: "agent_default_tier_unresolved",
    });
  });

  it("falls back when the agent default tier is half-empty", () => {
    // provider 残留、model_name 空：水合层保留的半空形态，运行期按失效回落。
    const agent = runtimeAgent({
      default: {
        provider: "system",
        provider_type: "deepseek",
        model_name: "",
        extra_params: {},
      },
    });

    const resolved = runtimeCore(new MemoryAgentConfigs({ agent }))
      .resolveExecutionConfig({ agentName: "agent" });

    expect(resolved.readiness.configuration_ready).toBe(true);
    expect(resolved.readiness.llm).toMatchObject({
      source: "system_config.llm",
      fallback_reason: "agent_default_tier_unresolved",
    });
  });

  it("falls back (annotated) when the agent has only non-default tiers", () => {
    // 仅有场景档、无 default：旧策略按显式选择报缺失；现按 default 缺档回落并标注。
    const agent = runtimeAgent({
      fast: {
        provider: "system",
        provider_type: "deepseek",
        model_name: "system-model",
        extra_params: {},
      },
    });

    const resolved = runtimeCore(new MemoryAgentConfigs({ agent }))
      .resolveExecutionConfig({ agentName: "agent" });

    expect(resolved.readiness).toMatchObject({
      configuration_ready: true,
      llm: {
        source: "system_config.llm",
        model_name: "system-model",
        fallback_reason: "agent_default_tier_unresolved",
      },
    });
    // 兜底注入只补 default，不丢弃已有的场景档。
    expect(resolved.agent?.llm_tiers).toHaveProperty("fast");
    expect(resolved.agent?.llm_tiers?.default).toMatchObject({ provider: "system", model_name: "system-model" });
  });

  it("preserves a resolvable scenario tier when the default tier falls back", () => {
    const agent = runtimeAgent({
      default: {
        provider: "deleted-provider",
        provider_type: "deepseek",
        model_name: "deleted-model",
        extra_params: {},
      },
      fast: {
        provider: "system",
        provider_type: "deepseek",
        model_name: "system-model",
        extra_params: {},
      },
    });

    const resolved = runtimeCore(new MemoryAgentConfigs({ agent }))
      .resolveExecutionConfig({ agentName: "agent" });

    expect(resolved.readiness.llm.source).toBe("system_config.llm");
    expect(resolved.agent?.llm_tiers?.fast?.provider).toBe("system");
    expect(resolved.agent?.llm_tiers?.default?.provider).toBe("system");
  });

  it("reports missing against the agent's raw refs when the system LLM also fails to resolve", () => {
    const agent = runtimeAgent({
      default: {
        provider: "deleted-provider",
        provider_type: "deepseek",
        model_name: "deleted-model",
        extra_params: {},
      },
    });
    const configs = new MemoryAgentConfigs({ agent });
    const service = new RuntimeCoreService(
      configs,
      new MemoryModelProviders(),
      new (class implements RuntimeSystemConfigPort {
        getLlmConfig(): SystemLlmConfig {
          return { ...systemLlm(), provider: "unregistered-system", model_name: "unregistered-model" };
        }
      })(),
    );

    const resolved = service.resolveExecutionConfig({ agentName: "agent" });

    // 系统 LLM 也失效：按 agent 原始引用报缺失，比系统空引用更有排查价值。
    expect(resolved.readiness.configuration_ready).toBe(false);
    expect(resolved.readiness.llm).toMatchObject({
      provider: "deleted-provider",
      model_name: "deleted-model",
      source: "missing",
      fallback_reason: null,
    });
    expect(resolved.agent?.llm_tiers?.default?.provider).toBe("deleted-provider");
  });

  it("does not fall back when the selectedLlm override itself is dangling", () => {
    // selectedLlm 是本次运行的显式选择：解析不到直接报缺失，不静默换 agent default / 系统 LLM。
    const agent = runtimeAgent({
      default: {
        provider: "system",
        provider_type: "deepseek",
        model_name: "system-model",
        extra_params: {},
      },
    });

    const resolved = runtimeCore(new MemoryAgentConfigs({ agent }))
      .resolveExecutionConfig({ agentName: "agent", selectedLlm: "deleted-provider|deepseek|deleted-model" });

    expect(resolved.readiness.configuration_ready).toBe(false);
    expect(resolved.readiness.llm).toMatchObject({
      provider: "deleted-provider",
      model_name: "deleted-model",
      source: "selected_llm",
      fallback_reason: null,
    });
    expect(resolved.readiness.requirements).toContainEqual(expect.objectContaining({
      key: "model_provider_config",
      satisfied: false,
    }));
  });

  it("resolves the agent tier without system fallback when systemConfig is not wired", () => {
    // 未注入 systemConfig 的部署形态：agent default 有效照常解析；失效则报缺失（无系统可回落）。
    const configs = new MemoryAgentConfigs({
      agent: runtimeAgent({
        default: { provider: "system", provider_type: "deepseek", model_name: "system-model", extra_params: {} },
      }),
      dangling: runtimeAgent({
        default: { provider: "deleted-provider", provider_type: "deepseek", model_name: "deleted-model", extra_params: {} },
      }),
    });
    const service = new RuntimeCoreService(configs, new MemoryModelProviders(), null);

    const valid = service.resolveExecutionConfig({ agentName: "agent" });
    expect(valid.readiness.llm).toMatchObject({ source: "agent_config.default", model_name: "system-model" });

    const dangling = service.resolveExecutionConfig({ agentName: "dangling" });
    expect(dangling.readiness.configuration_ready).toBe(false);
    expect(dangling.readiness.llm).toMatchObject({
      provider: "deleted-provider",
      source: "missing",
      fallback_reason: null,
    });
  });
});

describe("RuntimeCoreService team snapshot resolution", () => {
  it("re-reads the live agent config instead of the frozen snapshot tier", () => {
    // 存量会话快照里冻结的失效引用（provider 已删除），当前配置已迁移到新 tier。
    const snapshotAgent = runtimeAgent({
      default: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        temperature: 0.3,
        max_completion_tokens: 4096,
        max_context_tokens: 128000,
        extra_params: {},
      },
    });
    const liveAgent = runtimeAgent({
      default: {
        provider: "system",
        provider_type: "deepseek",
        model_name: "system-model",
        temperature: 0.1,
        max_completion_tokens: 1024,
        extra_params: {},
      },
    });

    const resolved = runtimeCore(new MemoryAgentConfigs({ agent: liveAgent }))
      .resolveExecutionConfig({ teamSnapshot: teamSnapshot({ agent: snapshotAgent }) });

    expect(resolved.readiness).toMatchObject({
      configuration_ready: true,
      llm: {
        provider: "system",
        model_name: "system-model",
        source: "agent_config.default",
      },
    });
    expect(resolved.agent?.llm_tiers?.default?.temperature).toBe(0.1);
  });

  it("fails readiness instead of falling back when the live team no longer has the agent", () => {
    const snapshotAgent = runtimeAgent({
      default: {
        provider: "system",
        provider_type: "deepseek",
        model_name: "system-model",
        temperature: 0.1,
        max_completion_tokens: 1024,
        extra_params: {},
      },
    });

    const resolved = runtimeCore(new MemoryAgentConfigs({}))
      .resolveExecutionConfig({ teamSnapshot: teamSnapshot({ agent: snapshotAgent }) });

    // 不回退快照副本：agent 已从当前配置消失属于配置问题，静默兜底会掩盖故障。
    expect(resolved.readiness.configuration_ready).toBe(false);
    expect(resolved.agent).toBeNull();
    expect(resolved.readiness.requirements).toContainEqual(expect.objectContaining({
      key: "entry_agent",
      satisfied: false,
      code: "missing_agent",
    }));
  });

  it("respects a live agent that has been disabled", () => {
    const snapshotAgent = runtimeAgent();
    const liveAgent = runtimeAgent();
    liveAgent.enabled = false;

    const resolved = runtimeCore(new MemoryAgentConfigs({ agent: liveAgent }))
      .resolveExecutionConfig({ teamSnapshot: teamSnapshot({ agent: snapshotAgent }) });

    expect(resolved.readiness.configuration_ready).toBe(false);
    expect(resolved.readiness.requirements).toContainEqual(expect.objectContaining({
      key: "agent_enabled",
      satisfied: false,
    }));
  });
});

function runtimeCore(agentConfigs: RuntimeAgentConfigPort): RuntimeCoreService {
  return new RuntimeCoreService(
    agentConfigs,
    new MemoryModelProviders(),
    new MemoryRuntimeSystemConfig(),
  );
}

function runtimeAgent(llmTiers?: Record<string, unknown>): AgentConfig {
  return AgentConfigSchema.parse({
    agent_name: "agent",
    display_name: "Agent",
    enabled: true,
    default_entry: true,
    ...(llmTiers !== undefined ? { llm_tiers: llmTiers } : {}),
    custom_params: {
      behavior: { system_prompt: "You are an agent." },
    },
  });
}

function teamSnapshot(agents: Record<string, AgentConfig>): SessionTeamSnapshot {
  const entryAgentName = Object.values(agents).find((config) => config.default_entry)?.agent_name
    ?? Object.keys(agents)[0]
    ?? "";
  return {
    team_name: "team",
    team_revision: "revision-1",
    entry_agent_name: entryAgentName,
    agents,
  };
}

function systemLlm(): SystemLlmConfig {
  return {
    provider: "system",
    provider_type: "deepseek",
    model_name: "system-model",
    temperature: 0.25,
    max_completion_tokens: 2048,
    max_context_tokens: 32000,
    extra_params: {},
  };
}

function systemProvider(): ModelProviderConfig {
  return {
    key: "system_deepseek",
    name: "system",
    provider_type: "deepseek",
    api_format: "openai_proxy",
    thinking_kind: "effort",
    api_key: "sk-test",
    api_endpoint: "https://api.deepseek.com/v1",
    models: [{ name: "system-model" }],
  };
}
