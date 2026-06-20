import { describe, expect, it } from "vitest";

import type { AgentConfig, AgentLlmConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { resolveRequestLlmParams } from "../../src/services/runtime/llm-params.js";

describe("resolveRequestLlmParams", () => {
  it("uses the default-tier params when running the default-tier model", () => {
    const params = resolveRequestLlmParams(
      agentWithDefault({ provider: "my", model_name: "deepseek-chat", temperature: 0.3, max_completion_tokens: 4096 }),
      makeProvider("my", "deepseek", "deepseek-chat", { temperature: 0.9, max_completion_tokens: 8192 }),
      "deepseek-chat",
    );
    expect(params).toEqual({ temperature: 0.3, maxCompletionTokens: 4096 });
  });

  it("uses the selected model's own provider params when it differs from the default tier", () => {
    const params = resolveRequestLlmParams(
      agentWithDefault({ provider: "my", model_name: "deepseek-chat", temperature: 0.3, max_completion_tokens: 4096 }),
      makeProvider("sel-prov", "openai", "sel-model", { temperature: 0.9, max_completion_tokens: 8192 }),
      "sel-model",
    );
    expect(params).toEqual({ temperature: 0.9, maxCompletionTokens: 8192 });
  });

  it("falls back to provider max_tokens when max_completion_tokens is absent (selected model)", () => {
    const provider = makeProvider("sel-prov", "openai", "sel-model", {});
    provider.max_tokens = 2048;
    const params = resolveRequestLlmParams(
      agentWithDefault({ provider: "my", model_name: "deepseek-chat", temperature: 0.3 }),
      provider,
      "sel-model",
    );
    expect(params).toEqual({ temperature: null, maxCompletionTokens: 2048 });
  });

  it("matches the default tier by provider key as well as name", () => {
    const params = resolveRequestLlmParams(
      agentWithDefault({ provider: "my_deepseek", model_name: "deepseek-chat", temperature: 0.2, max_completion_tokens: 1024 }),
      makeProvider("my", "deepseek", "deepseek-chat", { temperature: 0.9 }, "my_deepseek"),
      "deepseek-chat",
    );
    expect(params).toEqual({ temperature: 0.2, maxCompletionTokens: 1024 });
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
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
  } as unknown as AgentConfig;
}

function makeProvider(
  name: string,
  providerType: string,
  chatModel: string,
  params: { temperature?: number; max_completion_tokens?: number },
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
