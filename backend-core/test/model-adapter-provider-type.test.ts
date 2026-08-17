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
  it("exposes prompt cache controls only for protocols with supported request fields", () => {
    const types = new ModelAdapterService().listProviderTypes();
    const fields = (providerType: string) => types.find((item) => item.value === providerType)?.config_fields ?? [];

    for (const providerType of ["anthropic", "openai_chat", "openai_resp", "openrouter"]) {
      expect(fields(providerType).some((field) => field.key === "supports_prompt_caching")).toBe(true);
    }
    for (const providerType of ["deepseek", "modelscope", "openai_proxy"]) {
      expect(fields(providerType).some((field) => field.key === "supports_prompt_caching")).toBe(false);
    }
    expect(fields("anthropic").some((field) => field.key === "cache_ttl_seconds")).toBe(true);
    expect(fields("openai_chat").some((field) => field.key === "cache_ttl_seconds")).toBe(false);
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
});
