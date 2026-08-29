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
  models: [{ name: "gpt-4.1" }],
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
    // 内核类型清单封闭为 chat（无 rerank_api/embedding 位等外来概念）。
    expect(types.map((item) => item.value)).not.toContain("rerank_api");
    expect(types.every((item) => !("supports_embedding" in item) && !("supports_rerank" in item) && !("model_tasks" in item) && !("extension_id" in item))).toBe(true);
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
    expect(result.config.models).toEqual([{ name: "gpt-4.1" }]);
  });

  it("rejects unsupported provider types", () => {
    const service = new ModelAdapterService();

    expect(() => service.buildUpdateProvider("stable-provider-key", existing, {
      provider_type: "unsupported-provider",
    })).toThrowError(new ModelAdapterServiceError("不支持的 Provider 类型: unsupported-provider", 400));
  });

  it("create 校验模型条目（非对象/空名/重名/缺模型拒绝），未知键与废弃 provider 级字段剥离", () => {
    const service = new ModelAdapterService();
    const base = { name: "OpenAI", provider_type: "openai_chat", api_key: "secret" };

    expect(() => service.buildCreateProvider({ ...base, models: ["gpt-4.1"] }))
      .toThrowError(new ModelAdapterServiceError("每条模型必须包含非空 name", 400));
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: " " }] }))
      .toThrowError(new ModelAdapterServiceError("每条模型必须包含非空 name", 400));
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "gpt-4.1" }, { name: "gpt-4.1" }] }))
      .toThrowError(new ModelAdapterServiceError("模型名不能重复", 400));
    expect(() => service.buildCreateProvider({ ...base }))
      .toThrowError(new ModelAdapterServiceError("至少配置一个模型", 400));

    const { config } = service.buildCreateProvider({
      ...base,
      temperature: 0.9,
      model_map: { chat: "legacy" },
      supports_vision: true,
      models: [{ name: " gpt-4.1 ", temperature: 0.3, supports_vision: true, custom_key: "dropped" }],
    } as never);

    expect(config.models).toEqual([{ name: "gpt-4.1", temperature: 0.3, supports_vision: true }]);
    // 废弃的 provider 级字段（模型映射/运行参数/能力位）不再落盘。
    expect(config.temperature).toBeUndefined();
    expect(config.model_map).toBeUndefined();
    expect(config.supports_vision).toBeUndefined();
  });

  it("update 可整体替换 models；未提供时保留原模型目录", () => {
    const service = new ModelAdapterService();
    const result = service.buildUpdateProvider("stable-provider-key", existing, {
      models: [{ name: "claude-sonnet-4", max_completion_tokens: 8192 }, { name: "claude-haiku" }],
    });
    expect(result.config.models).toEqual([
      { name: "claude-sonnet-4", max_completion_tokens: 8192 },
      { name: "claude-haiku" },
    ]);

    const untouched = service.buildUpdateProvider("stable-provider-key", existing, { timeout: 60 });
    expect(untouched.config.models).toEqual([{ name: "gpt-4.1" }]);
  });

  it("availability 以 models 判定 chat 模型配置", () => {
    const service = new ModelAdapterService();
    service.createProvider({
      name: "OpenAI",
      provider_type: "openai_chat",
      api_key: "secret",
      models: [{ name: "gpt-4.1" }],
    });
    expect(service.checkProviderAvailability("openai_openai_chat").checks.chat_model_configured).toBe(true);
  });

  it("runtime hydration skips plugin-era entries（类型未知即整条跳过）；水合剥离废弃字段与非法模型条目", () => {
    const service = new ModelAdapterService();
    expect(() => service.replaceRuntimeProviders([
      {
        key: "media",
        name: "智谱媒体",
        provider_type: "media_generation",
        api_key: "secret",
        models: [],
      },
      {
        key: "rerank",
        name: "Rerank",
        provider_type: "rerank_api",
        api_key: "secret",
        api_endpoint: "https://rerank.example.com",
        models: [],
      },
      {
        key: "chat",
        name: "Chat",
        provider_type: "openai_chat",
        api_key: "secret",
        temperature: 0.9,
        model_map: { chat: "legacy-model" },
        models: [{ name: "gpt-4.1", temperature: 0.2 }, { name: "gpt-4.1" }, "legacy-string"],
      } as unknown as ModelProviderConfig,
    ])).not.toThrow();
    expect(service.hasProvider("media")).toBe(false);
    expect(service.hasProvider("rerank")).toBe(false);
    expect(service.hasProvider("chat")).toBe(true);
    const chat = service.getProvider("chat");
    expect(chat?.models).toEqual([{ name: "gpt-4.1", temperature: 0.2 }]);
    expect(chat?.temperature).toBeUndefined();
    expect(chat?.model_map).toBeUndefined();
  });
});
