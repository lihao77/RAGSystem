import { describe, expect, it } from "vitest";

import { AgentConfigSchema, type AgentConfig } from "../src/contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";
import type { ISystemConfigStore } from "../src/contracts/runtime/system-config-store.js";
import type { SystemConfigData, SystemLlmConfig } from "../src/contracts/runtime/system-config.js";
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
        temperature: 0.7,
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
    expect(resolved.agent?.llm_tiers?.default?.temperature).toBe(0.1);
  });

  it("does not use the fallback when the agent has any non-default tier", () => {
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

    expect(resolved.readiness.configuration_ready).toBe(false);
    expect(resolved.readiness.llm.source).toBe("missing");
    expect(resolved.agent?.llm_tiers).toHaveProperty("fast");
    expect(resolved.agent?.llm_tiers).not.toHaveProperty("default");
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
    api_key: "sk-test",
    model_map: { chat: "system-model" },
    models: ["system-model"],
  };
}
