import { describe, expect, it } from "vitest";

import type { AgentConfig, AgentLlmConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { resolveTierLlmParams } from "../../src/services/agent/llm-params.js";

describe("resolveTierLlmParams", () => {
  it("uses default-tier params for tier=default when running the default-tier model", () => {
    const params = resolveTierLlmParams({
      agent: agentWithDefault({ provider: "my", model_name: "deepseek-chat", temperature: 0.3, max_completion_tokens: 4096 }),
      tier: "default",
      runModel: {
        provider: makeProvider("my", "deepseek", "deepseek-chat", { temperature: 0.9, max_completion_tokens: 8192 }),
        modelName: "deepseek-chat",
      },
      systemLlm: null,
    });
    expect(params).toEqual({ temperature: 0.3, maxCompletionTokens: 4096, extraParams: {} });
  });

  it("uses the selected provider's params when selectedLlm replaces default", () => {
    const params = resolveTierLlmParams({
      agent: agentWithDefault({ provider: "my", model_name: "deepseek-chat", temperature: 0.3, max_completion_tokens: 4096 }),
      tier: "default",
      runModel: {
        provider: makeProvider("sel-prov", "openai", "sel-model", { temperature: 0.9, max_completion_tokens: 8192 }),
        modelName: "sel-model",
      },
      systemLlm: null,
    });
    expect(params).toEqual({ temperature: 0.9, maxCompletionTokens: 8192, extraParams: {} });
  });

  it("falls back to provider max_tokens when max_completion_tokens is absent (selected model)", () => {
    const provider = makeProvider("sel-prov", "openai", "sel-model", {});
    provider.max_tokens = 2048;
    const params = resolveTierLlmParams({
      agent: agentWithDefault({ provider: "my", model_name: "deepseek-chat", temperature: 0.3 }),
      tier: "default",
      runModel: { provider, modelName: "sel-model" },
      systemLlm: null,
    });
    expect(params).toEqual({ temperature: null, maxCompletionTokens: 2048, extraParams: {} });
  });

  it("matches the default tier by provider key as well as name", () => {
    const params = resolveTierLlmParams({
      agent: agentWithDefault({ provider: "my_deepseek", model_name: "deepseek-chat", temperature: 0.2, max_completion_tokens: 1024 }),
      tier: "default",
      runModel: {
        provider: makeProvider("my", "deepseek", "deepseek-chat", { temperature: 0.9 }, "my_deepseek"),
        modelName: "deepseek-chat",
      },
      systemLlm: null,
    });
    expect(params).toEqual({ temperature: 0.2, maxCompletionTokens: 1024, extraParams: {} });
  });

  it("uses fast-tier params for tier=fast, falling back to default then system", () => {
    const agent = agentWithDefault({ provider: "my", model_name: "deepseek-chat", temperature: 0.3, max_completion_tokens: 4096 });
    agent.llm_tiers!.fast = {
      provider: "my",
      provider_type: "deepseek",
      model_name: "deepseek-chat",
      temperature: 0.1,
      max_completion_tokens: 1024,
      extra_params: { top_p: 0.8 },
    } as AgentLlmConfig;
    const params = resolveTierLlmParams({
      agent,
      tier: "fast",
      runModel: { provider: makeProvider("my", "deepseek", "deepseek-chat", {}), modelName: "deepseek-chat" },
      systemLlm: null,
    });
    expect(params.temperature).toBe(0.1);
    expect(params.maxCompletionTokens).toBe(1024);
    expect(params.extraParams).toEqual({ top_p: 0.8 });
  });

  it("falls default→system per-field when the tier omits a field", () => {
    // fast 未配 temperature、default 也未配 → system 兜底；max_completion default 有值不回落。
    const agent = agentWithDefault({ provider: "my", model_name: "deepseek-chat", max_completion_tokens: 4096 });
    agent.llm_tiers!.fast = { provider: "my", model_name: "deepseek-chat", extra_params: {} } as AgentLlmConfig;
    const params = resolveTierLlmParams({
      agent,
      tier: "fast",
      runModel: { provider: makeProvider("my", "deepseek", "deepseek-chat", {}), modelName: "deepseek-chat" },
      systemLlm: { temperature: 0.7 },
    });
    expect(params.temperature).toBe(0.7);
    expect(params.maxCompletionTokens).toBe(4096);
  });

  it("merges extra_params across system → default → tier (later overrides earlier)", () => {
    const agent = agentWithDefault({
      provider: "my",
      model_name: "deepseek-chat",
      extra_params: { from_default: 1, shared: "default" },
    });
    agent.llm_tiers!.fast = {
      provider: "my",
      model_name: "deepseek-chat",
      extra_params: { from_fast: 2, shared: "fast" },
    } as AgentLlmConfig;
    const params = resolveTierLlmParams({
      agent,
      tier: "fast",
      runModel: { provider: makeProvider("my", "deepseek", "deepseek-chat", {}), modelName: "deepseek-chat" },
      systemLlm: { extra_params: { from_system: 0, shared: "system" } },
    });
    expect(params.extraParams).toEqual({ from_system: 0, from_default: 1, from_fast: 2, shared: "fast" });
  });

  it("selectedLlm replaces default: extra_params come from provider, not agent.default", () => {
    const provider = makeProvider("sel-prov", "openai", "sel-model", {});
    (provider as Record<string, unknown>).extra_params = { top_p: 0.9 };
    const params = resolveTierLlmParams({
      agent: agentWithDefault({ provider: "my", model_name: "deepseek-chat", extra_params: { presence_penalty: 0.5 } }),
      tier: "default",
      runModel: { provider, modelName: "sel-model" },
      systemLlm: { extra_params: { from_system: 1 } },
    });
    expect(params.extraParams).toEqual({ from_system: 1, top_p: 0.9 });
  });

  it("drops null/undefined entries from extra_params", () => {
    // selectedLlm 场景（runModel != agent.default）→ defaultSource 取 provider.extra_params。
    const provider = makeProvider("sel-prov", "openai", "sel-model", {});
    (provider as Record<string, unknown>).extra_params = { top_p: 0.9, dropped: null, gone: undefined };
    const params = resolveTierLlmParams({
      agent: agentWithDefault({ provider: "my", model_name: "deepseek-chat", extra_params: {} }),
      tier: "default",
      runModel: { provider, modelName: "sel-model" },
      systemLlm: null,
    });
    expect(params.extraParams).toEqual({ top_p: 0.9 });
  });
});

function agentWithDefault(tier: Partial<AgentLlmConfig> & { provider: string; model_name: string }): AgentConfig {
  return {
    agent_name: "a",
    display_name: null,
    description: null,
    enabled: true,
    default_entry: true,
    llm_tiers: { default: { extra_params: {}, ...tier } as AgentLlmConfig },
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [] },
    mcp: { enabled_servers: [] },
  } as unknown as AgentConfig;
}

function makeProvider(
  name: string,
  providerType: string,
  chatModel: string,
  params: { temperature?: number; max_completion_tokens?: number; extra_params?: Record<string, unknown> },
  key?: string,
): ModelProviderConfig {
  return {
    name,
    key: key ?? `${name}_${providerType}`,
    provider_type: providerType,
    api_key: "sk-test",
    models: [chatModel],
    model_map: { chat: chatModel },
    ...params,
  };
}
