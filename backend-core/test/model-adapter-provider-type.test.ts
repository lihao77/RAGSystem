import { describe, expect, it } from "vitest";

import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";
import {
  ModelAdapterService,
  ModelAdapterServiceError,
} from "../src/services/integrations/model-adapter-service.js";

const existing: ModelProviderConfig = {
  key: "stable-provider-key",
  name: "Stable Provider",
  provider_type: "openai_chat",
  api_key: "secret",
  api_endpoint: "https://api.openai.com/v1",
  model_map: { chat: "gpt-4.1" },
  models: ["gpt-4.1"],
};

describe("ModelAdapterService provider type updates", () => {
  it("exposes prompt cache controls from provider capabilities", () => {
    const types = new ModelAdapterService().listProviderTypes();
    const fields = (providerType: string) => types.find((item) => item.value === providerType)?.config_fields ?? [];

    for (const providerType of ["anthropic", "openrouter"]) {
      expect(fields(providerType).some((field) => field.key === "supports_prompt_caching")).toBe(true);
    }
    for (const providerType of ["gemini", "mistral", "groq", "qwen", "deepseek", "modelscope", "openai_proxy", "openai_chat", "openai_resp"]) {
      expect(fields(providerType).some((field) => field.key === "supports_prompt_caching")).toBe(false);
    }
    expect(fields("anthropic").some((field) => field.key === "cache_ttl_seconds")).toBe(true);
    expect(fields("gemini").some((field) => field.key === "cache_ttl_seconds")).toBe(false);
    expect(fields("openai_chat").some((field) => field.key === "cache_ttl_seconds")).toBe(false);
    expect(types.find((item) => item.value === "mistral")?.default_endpoint).toBe("https://api.mistral.ai/v1");
    expect(types.find((item) => item.value === "groq")?.default_endpoint).toBe("https://api.groq.com/openai/v1");
    expect(types.find((item) => item.value === "qwen")?.default_endpoint).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(types.find((item) => item.value === "gemini")?.supports_embedding).toBe(false);
    expect(types.find((item) => item.value === "groq")?.supports_embedding).toBe(false);
    expect(types.find((item) => item.value === "deepseek")?.supports_embedding).toBe(false);
    expect(types.find((item) => item.value === "qwen")?.supports_embedding).toBe(true);
    expect(types.find((item) => item.value === "openrouter")?.supports_rerank).toBe(true);
    expect(types.find((item) => item.value === "qwen")?.supports_rerank).toBe(false);
  });

  it("changes provider type while preserving the stable provider key", () => {
    const service = new ModelAdapterService();
    const result = service.buildUpdateProvider("stable-provider-key", existing, {
      provider_type: "anthropic",
      api_endpoint: "https://api.anthropic.com",
    });

    expect(result.key).toBe("stable-provider-key");
    expect(result.config.provider_type).toBe("anthropic");
    expect(result.config.api_endpoint).toBe("https://api.anthropic.com");
  });

  it("rejects unsupported provider types", () => {
    const service = new ModelAdapterService();

    expect(() => service.buildUpdateProvider("stable-provider-key", existing, {
      provider_type: "unsupported-provider",
    })).toThrowError(new ModelAdapterServiceError("不支持的 Provider 类型: unsupported-provider", 400));
  });

  it("rejects embedding configuration for providers without embedding capability", () => {
    const service = new ModelAdapterService();

    expect(() => service.buildCreateProvider({
      name: "Gemini",
      provider_type: "gemini",
      api_key: "secret",
      model_map: { embedding: "text-embedding-model" },
    })).toThrowError(new ModelAdapterServiceError("Provider 类型 gemini 不支持 model_map.embedding", 400));
  });

  it("rejects rerank configuration for providers without the unified rerank adapter", () => {
    const service = new ModelAdapterService();

    expect(() => service.buildCreateProvider({
      name: "Qwen",
      provider_type: "qwen",
      api_key: "secret",
      model_map: { rerank: "qwen3-rerank" },
    })).toThrowError(new ModelAdapterServiceError("Provider 类型 qwen 不支持 model_map.rerank", 400));
  });

  it("rejects embedding tests before invoking an incompatible endpoint", async () => {
    const service = new ModelAdapterService();
    service.replaceRuntimeProviders([{
      key: "gemini",
      name: "Gemini",
      provider_type: "gemini",
      api_key: "secret",
      model_map: { chat: "gemini-2.5-flash" },
      models: ["gemini-2.5-flash"],
    }]);

    await expect(service.testProvider({
      provider: "gemini",
      task: "embedding",
      model: "text-embedding-model",
      prompt: "hello",
    })).rejects.toThrowError(new ModelAdapterServiceError("Provider 类型 gemini 不支持 Embedding", 400));
  });
});
