import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ModelProviderConfig, ProviderTypeInfo } from "../src/contracts/integrations/model-adapter.js";
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

const mediaType: ProviderTypeInfo = {
  value: "media_generation",
  label: "媒体生成",
  default_endpoint: "",
  supports_embedding: false,
  supports_rerank: false,
  config_fields: [
    { key: "vendor", label: "厂商", type: "select", default: "", help: "", options: [{ value: "zhipu", label: "智谱" }] },
  ],
  model_tasks: [
    { value: "image", label: "生图模型" },
    { value: "video", label: "生视频模型" },
  ],
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempProvidersFile(initialYaml?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-provider-types-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "providers.yaml");
  if (initialYaml !== undefined) {
    fs.writeFileSync(filePath, initialYaml, "utf8");
  }
  return filePath;
}

describe("ModelAdapterService plugin provider types", () => {
  it("merges plugin types into listProviderTypes with extension stamps", () => {
    const service = new ModelAdapterService();
    service.registerProviderTypes("@ragsystem/backend-plugin-media-generation", [mediaType]);

    const listed = service.listProviderTypes().find((item) => item.value === "media_generation");
    expect(listed?.extension_id).toBe("@ragsystem/backend-plugin-media-generation");
    expect(listed?.label).toBe("媒体生成");
    expect(listed?.model_tasks).toEqual([{ value: "image", label: "生图模型" }, { value: "video", label: "生视频模型" }]);
    // 内置类型不带 extension_id
    expect(service.listProviderTypes().find((item) => item.value === "openai_chat")?.extension_id).toBeUndefined();
  });

  it("rejects conflicts with builtin types and other extensions", () => {
    const service = new ModelAdapterService();
    expect(() => service.registerProviderTypes("ext-a", [{ ...mediaType, value: "openai_chat" }]))
      .toThrowError(ModelAdapterServiceError);
    expect(() => service.registerProviderTypes("ext-a", [{ ...mediaType, value: "bad-type" }]))
      .toThrowError(ModelAdapterServiceError);

    service.registerProviderTypes("ext-a", [mediaType]);
    expect(() => service.registerProviderTypes("ext-b", [mediaType])).toThrowError(ModelAdapterServiceError);
  });

  it("lets the same extension re-register and unregister its types", () => {
    const service = new ModelAdapterService();
    service.registerProviderTypes("ext-a", [mediaType]);
    service.registerProviderTypes("ext-a", [{ ...mediaType, value: "media_ark", label: "火山方舟 · 图像/视频生成" }]);

    expect(service.listProviderTypes().some((item) => item.value === "media_generation")).toBe(false);
    expect(service.listProviderTypes().some((item) => item.value === "media_ark")).toBe(true);

    const unregister = service.registerProviderTypes("ext-a", [mediaType]);
    expect(service.isPluginProviderType("media_generation")).toBe(true);
    unregister();
    expect(service.isPluginProviderType("media_generation")).toBe(false);
    expect(service.listProviderTypes().some((item) => item.value === "media_generation")).toBe(false);
  });

  it("creates plugin-typed providers without model_map and reports them available", () => {
    const service = new ModelAdapterService();
    service.registerProviderTypes("ext-a", [mediaType]);

    const { config } = service.buildCreateProvider({
      name: "智谱媒体",
      provider_type: "media_generation",
      api_key: "secret",
    });
    expect(config.provider_type).toBe("media_generation");
    expect(config.models).toEqual([]);

    service.createProvider({ name: "智谱媒体", provider_type: "media_generation", api_key: "secret", vendor: "zhipu", model_map: { image: "glm-image", video: "cogvideox-3" } });
    const availability = service.checkProviderAvailability("智谱媒体_media_generation");
    expect(availability.is_available).toBe(true);
    expect(availability.error).toBeNull();
  });

  it("rejects online testing for plugin-managed provider types", async () => {
    const service = new ModelAdapterService();
    service.registerProviderTypes("ext-a", [mediaType]);
    service.createProvider({ name: "智谱媒体", provider_type: "media_generation", api_key: "secret", model_map: { image: "glm-image", video: "cogvideox-3" } });

    await expect(service.testProvider({ provider: "智谱媒体", prompt: "hello" }))
      .rejects.toThrowError(new ModelAdapterServiceError("该 Provider 类型由 ext-a 提供，暂不支持在线测试", 400));
  });

  it("accepts plugin-typed providers in runtime hydration", () => {
    const service = new ModelAdapterService();
    service.registerProviderTypes("ext-a", [mediaType]);

    expect(() => service.replaceRuntimeProviders([{
      key: "media",
      name: "智谱媒体",
      provider_type: "media_generation",
      api_key: "secret",
      model_map: { image: "glm-image" },
    }])).not.toThrow();
    expect(service.getProvider("media")?.provider_type).toBe("media_generation");
  });

  it("skips (not throws) stale plugin-typed entries after the plugin is gone", () => {
    // 插件禁用/移除后其类型未注册：残留条目必须被跳过，水合失败会让整个租户不可用
    const service = new ModelAdapterService();
    expect(() => service.replaceRuntimeProviders([
      {
        key: "media",
        name: "智谱媒体",
        provider_type: "media_generation",
        api_key: "secret",
        model_map: { image: "glm-image" },
      },
      {
        key: "chat",
        name: "Chat",
        provider_type: "openai_chat",
        api_key: "secret",
        model_map: { chat: "gpt-4.1" },
      },
    ])).not.toThrow();
    expect(service.hasProvider("media")).toBe(false);
    expect(service.hasProvider("chat")).toBe(true);
  });

  it("reloads providers.yaml entries skipped before plugin types were registered", () => {
    const filePath = makeTempProvidersFile([
      "media:",
      "  name: 智谱媒体",
      "  provider_type: media_generation",
      "  api_key: secret",
      "  vendor: zhipu",
      "  model_map:",
      "    image: glm-image",
      "",
    ].join("\n"));

    const service = new ModelAdapterService({ providersConfigPath: filePath });
    // 类型未注册时该条目被跳过
    expect(service.hasProvider("media")).toBe(false);

    service.registerProviderTypes("ext-a", [mediaType]);
    const provider = service.getProvider("media");
    expect(provider?.provider_type).toBe("media_generation");
    expect(provider?.api_key).toBe("secret");
    expect(provider?.vendor).toBe("zhipu");
    expect(provider?.models).toContain("glm-image");
  });

  it("passes plugin-declared extension fields through provider updates", () => {
    const service = new ModelAdapterService();
    service.registerProviderTypes("ext-a", [mediaType]);
    const key = service.createProvider({
      name: "智谱媒体",
      provider_type: "media_generation",
      api_key: "secret",
      vendor: "zhipu",
      model_map: { image: "glm-image", video: "cogvideox-3" },
    });

    service.updateProvider(key, { vendor: "volcengine", api_endpoint: "https://ark.cn-beijing.volces.com" });
    const provider = service.getProvider(key);
    // 白名单外的插件扩展字段（vendor）在更新后保留且生效
    expect(provider?.vendor).toBe("volcengine");
    expect(provider?.api_endpoint).toBe("https://ark.cn-beijing.volces.com");
    expect(provider?.models).toContain("glm-image");
  });

  it("reports plugin-typed providers without models as not available", () => {
    const service = new ModelAdapterService();
    service.registerProviderTypes("ext-a", [mediaType]);
    service.createProvider({ name: "智谱媒体", provider_type: "media_generation", api_key: "secret" });

    const availability = service.checkProviderAvailability("智谱媒体_media_generation");
    expect(availability.is_available).toBe(false);
    expect(availability.error).toContain("模型");
  });
});
