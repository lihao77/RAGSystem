import { describe, expect, it } from "vitest";

import { AgentConfigSchema } from "../src/contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";
import { projectAgentProfile } from "../src/services/agent/sdk/projection.js";

const provider: ModelProviderConfig = {
  key: "openai_openai_chat",
  name: "openai",
  provider_type: "openai",
  api_format: "openai_chat",
  api_key: "sk-test",
  models: [
    { name: "vision-model", input_modalities: ["text", "image"], supports_function_calling: true },
    { name: "text-model", input_modalities: ["text"] },
    { name: "audio-model", input_modalities: ["text", "audio", "pdf"] },
    { name: "deepseek-style", thinking_levels: ["low", "high", "max"] },
    { name: "details-dialect", reasoning_field: "reasoning_details" },
  ],
};

function agentWithModel(modelName: string) {
  return AgentConfigSchema.parse({
    agent_name: "agent",
    display_name: "Agent",
    enabled: true,
    default_entry: true,
    llm_tiers: {
      // tier 引用的 provider_type 与 provider 条目一致 = 厂商（findProviderByRef 按厂商匹配）。
      default: { provider: "openai", provider_type: "openai", model_name: modelName, extra_params: {} },
    },
    custom_params: { behavior: { system_prompt: "You are an agent." } },
  });
}

describe("tier projection derives supports_vision from model input modalities", () => {
  it("输入模态含 image → 内联 provider supports_vision true；纯文本/其他模态 → false", () => {
    const visionTier = projectAgentProfile({ agent: agentWithModel("vision-model"), providers: [provider] }).llmTiers.default;
    expect(visionTier?.provider.supports_vision).toBe(true);
    expect(visionTier?.provider.supports_function_calling).toBe(true);

    const textTier = projectAgentProfile({ agent: agentWithModel("text-model"), providers: [provider] }).llmTiers.default;
    expect(textTier?.provider.supports_vision).toBe(false);

    const audioTier = projectAgentProfile({ agent: agentWithModel("audio-model"), providers: [provider] }).llmTiers.default;
    expect(audioTier?.provider.supports_vision).toBe(false);
  });

  it("内联 provider 的 provider_type 为 API 格式（agent-llm 按格式分发，厂商不是分发键）", () => {
    const tier = projectAgentProfile({ agent: agentWithModel("vision-model"), providers: [provider] }).llmTiers.default;
    expect(tier?.provider.provider_type).toBe("openai_chat");
    expect(tier?.modelName).toBe("vision-model");
  });

  it("模型级 thinking_levels 子集随条目合并进内联 provider；未配置 → null", () => {
    const subset = projectAgentProfile({ agent: agentWithModel("deepseek-style"), providers: [provider] }).llmTiers.default;
    expect((subset?.provider as unknown as Record<string, unknown>).thinking_levels).toEqual(["low", "high", "max"]);

    const plain = projectAgentProfile({ agent: agentWithModel("text-model"), providers: [provider] }).llmTiers.default;
    expect((plain?.provider as unknown as Record<string, unknown>).thinking_levels).toBeNull();
  });

  it("模型级 reasoning_field 声明（思考线方言）随条目合并；未配置 → null", () => {
    const tier = projectAgentProfile({ agent: agentWithModel("details-dialect"), providers: [provider] }).llmTiers.default;
    expect((tier?.provider as unknown as Record<string, unknown>).reasoning_field).toBe("reasoning_details");

    const plain = projectAgentProfile({ agent: agentWithModel("text-model"), providers: [provider] }).llmTiers.default;
    expect((plain?.provider as unknown as Record<string, unknown>).reasoning_field).toBeNull();
  });

  it("模型条目缺失/未配置模态 → supports_vision 置 null（消费点按未知能力处理）", () => {
    const agent = AgentConfigSchema.parse({
      agent_name: "agent",
      display_name: "Agent",
      enabled: true,
      default_entry: true,
      llm_tiers: {
        default: { provider: "openai", provider_type: "openai", model_name: "unlisted-model", extra_params: {} },
      },
      custom_params: { behavior: { system_prompt: "You are an agent." } },
    });
    const bareProvider: ModelProviderConfig = { ...provider, models: [{ name: "unlisted-model" }] };
    const tier = projectAgentProfile({ agent, providers: [bareProvider] }).llmTiers.default;
    expect(tier?.provider.supports_vision).toBeNull();
  });
});
