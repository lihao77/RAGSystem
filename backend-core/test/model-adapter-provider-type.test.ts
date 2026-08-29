import { describe, expect, it } from "vitest";

import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";
import {
  ModelAdapterService,
  ModelAdapterServiceError,
} from "../src/services/integrations/model-adapter-service.js";

const existing: ModelProviderConfig = {
  key: "stable-provider-key",
  name: "Stable Provider",
  provider_type: "openai",
  api_format: "openai_chat",
  api_key: "secret",
  api_endpoint: "https://api.openai.com/v1",
  models: [{ name: "gpt-4.1" }],
};

describe("ModelAdapterService provider configuration (provider_type=厂商, api_format=API 格式)", () => {
  it("listApiFormats 暴露封闭的 5 种纯协议格式（无厂商类型）", () => {
    const formats = new ModelAdapterService().listApiFormats();
    expect(formats.map((item) => item.value)).toEqual(["openai_resp", "openai_chat", "openai_proxy", "anthropic", "gemini"]);
    const fields = (apiFormat: string) => formats.find((item) => item.value === apiFormat)?.config_fields ?? [];
    expect(fields("anthropic").some((field) => field.key === "supports_prompt_caching")).toBe(true);
    for (const apiFormat of ["gemini", "openai_proxy", "openai_chat", "openai_resp"]) {
      expect(fields(apiFormat).some((field) => field.key === "supports_prompt_caching")).toBe(false);
    }
    expect(fields("anthropic").some((field) => field.key === "cache_ttl_seconds")).toBe(true);
    expect(fields("gemini").some((field) => field.key === "cache_ttl_seconds")).toBe(false);
    expect(formats.find((item) => item.value === "openai_chat")?.default_endpoint).toBe("https://api.openai.com/v1");
  });

  it("update 可切换 API 格式与厂商（自由字符串），thinking_kind 声明随行（非法值剔除）", () => {
    const service = new ModelAdapterService();
    const result = service.buildUpdateProvider("stable-provider-key", existing, {
      api_format: "anthropic",
      api_endpoint: "https://api.anthropic.com",
    });
    expect(result.key).toBe("stable-provider-key");
    expect(result.config.api_format).toBe("anthropic");
    expect(result.config.provider_type).toBe("openai");

    const rebranded = service.buildUpdateProvider("stable-provider-key", result.config, {
      provider_type: " ZhipuAi ",
      thinking_kind: " TOGGLE ",
    });
    expect(rebranded.config.provider_type).toBe("zhipuai");
    expect(rebranded.config.api_format).toBe("anthropic");
    expect(rebranded.config.thinking_kind).toBe("toggle");

    const invalidKind = service.buildUpdateProvider("stable-provider-key", rebranded.config, { thinking_kind: "bogus" });
    expect(invalidKind.config.thinking_kind).toBeUndefined();
  });

  it("rejects unknown or missing api formats (厂商自由、格式封闭)", () => {
    const service = new ModelAdapterService();
    expect(() => service.buildUpdateProvider("stable-provider-key", existing, { api_format: "unsupported-format" }))
      .toThrowError(new ModelAdapterServiceError("不支持的 API 格式: unsupported-format", 400));
    expect(() => service.buildUpdateProvider("stable-provider-key", existing, { api_format: "" }))
      .toThrowError(new ModelAdapterServiceError("不支持的 API 格式: (空)", 400));

    const base = { name: "Zhipu", provider_type: "zhipuai", api_key: "secret" };
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "glm-5" }] }))
      .toThrowError(new ModelAdapterServiceError("缺少必需字段: api_format", 400));
    expect(() => service.buildCreateProvider({ ...base, api_format: "openai_native", models: [{ name: "glm-5" }] }))
      .toThrowError(new ModelAdapterServiceError("不支持的 API 格式: openai_native", 400));
    // api_format 别名归一：openai_compatible_chat → openai_proxy、openai → openai_chat（厂商不受影响）。
    const aliased = service.buildCreateProvider({
      ...base,
      api_format: "openai_compatible_chat",
      api_endpoint: "https://open.bigmodel.cn/api/paas/v4",
      models: [{ name: "glm-5" }],
    });
    expect(aliased.config.api_format).toBe("openai_proxy");
    expect(aliased.config.provider_type).toBe("zhipuai");
    const openaiAlias = service.buildCreateProvider({
      name: "OpenAI", provider_type: "openai", api_key: "secret", api_format: "openai",
      models: [{ name: "gpt-4.1" }],
    });
    expect(openaiAlias.config.api_format).toBe("openai_chat");
  });

  it("create 校验模型条目（非对象/空名/重名/缺模型/模态非数组拒绝），未知键与废弃字段剥离", () => {
    const service = new ModelAdapterService();
    const base = { name: "OpenAI", provider_type: "openai", api_format: "openai_chat", api_key: "secret" };

    expect(() => service.buildCreateProvider({ ...base, models: ["gpt-4.1"] }))
      .toThrowError(new ModelAdapterServiceError("每条模型必须包含非空 name", 400));
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: " " }] }))
      .toThrowError(new ModelAdapterServiceError("每条模型必须包含非空 name", 400));
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "gpt-4.1" }, { name: "gpt-4.1" }] }))
      .toThrowError(new ModelAdapterServiceError("模型名不能重复", 400));
    expect(() => service.buildCreateProvider({ ...base, models: [] }))
      .toThrowError(new ModelAdapterServiceError("至少配置一个模型", 400));
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "gpt-4.1", input_modalities: "text" }] }))
      .toThrowError(new ModelAdapterServiceError("输入模态必须是数组", 400));
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "gpt-4.1", output_modalities: null }] }))
      .toThrowError(new ModelAdapterServiceError("输出模态必须是数组", 400));
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "gpt-4.1", thinking_levels: "low" }] }))
      .toThrowError(new ModelAdapterServiceError("思考档位必须是数组", 400));

    const { config } = service.buildCreateProvider({
      ...base,
      temperature: 0.9,
      model_map: { chat: "legacy" },
      supports_vision: true,
      catalog_provider_id: "openai",
      models: [{
        name: " gpt-4.1 ",
        temperature: 0.3,
        supports_vision: true,
        input_modalities: ["text", "image", "IMAGE", "bogus"],
        output_modalities: ["text"],
        // 目录 effort 值域：未知 token/off 过滤，按全集顺序输出（deepseek 风格 low/high/max）
        thinking_levels: ["max", "off", "low", "high", "on", "bogus", "high"],
        // 思考线字段声明：白名单两值，非法值静默丢弃
        reasoning_field: "reasoning_details",
        custom_key: "dropped",
      }, {
        name: "bad-field-model",
        reasoning_field: "reasoning",
      }],
    } as never);

    // 能力以模态表达：supports_vision（旧位）剔除，未知模态 token 过滤、大小写归一去重。
    expect(config.models).toEqual([
      {
        name: "gpt-4.1",
        temperature: 0.3,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        thinking_levels: ["low", "high", "max"],
        reasoning_field: "reasoning_details",
      },
      { name: "bad-field-model" },
    ]);
    // 废弃的 provider 级字段（模型映射/运行参数/能力位/厂商目录临时补丁）不再落盘。
    expect(config.temperature).toBeUndefined();
    expect(config.model_map).toBeUndefined();
    expect(config.supports_vision).toBeUndefined();
    expect(config.catalog_provider_id).toBeUndefined();
  });

  it("update 可整体替换 models；未提供时保留原模型目录", () => {
    const service = new ModelAdapterService();
    const result = service.buildUpdateProvider("stable-provider-key", existing, {
      models: [{ name: "gpt-4.1-mini", max_completion_tokens: 8192 }, { name: "o4-mini" }],
    });
    expect(result.config.models).toEqual([
      { name: "gpt-4.1-mini", max_completion_tokens: 8192 },
      { name: "o4-mini" },
    ]);

    const untouched = service.buildUpdateProvider("stable-provider-key", existing, { timeout: 60 });
    expect(untouched.config.models).toEqual([{ name: "gpt-4.1" }]);
  });

  it("availability 以 api_format + models 判定", () => {
    const service = new ModelAdapterService();
    service.createProvider({
      name: "Zhipu",
      provider_type: "zhipuai",
      api_format: "openai_proxy",
      api_key: "secret",
      api_endpoint: "https://open.bigmodel.cn/api/paas/v4",
      models: [{ name: "glm-5" }],
    });
    // key = 名称_厂商（api_format 不参与 key）。
    const availability = service.checkProviderAvailability("zhipu_zhipuai");
    expect(availability.checks.api_format_supported).toBe(true);
    expect(availability.checks.chat_model_configured).toBe(true);
    expect(availability.is_available).toBe(true);
  });

  it("runtime hydration 跳过无有效 api_format 的条目（旧形态/插件残留）；水合剥离废弃字段与非法模型条目", () => {
    const service = new ModelAdapterService();
    expect(() => service.replaceRuntimeProviders([
      {
        key: "legacy-format-entry",
        name: "Legacy",
        provider_type: "openai_chat",
        api_key: "secret",
        models: [],
      },
      {
        key: "chat",
        name: "Chat",
        provider_type: "zhipuai",
        api_format: "OPENAI_PROXY",
        api_key: "secret",
        temperature: 0.9,
        model_map: { chat: "legacy-model" },
        catalog_provider_id: "zhipuai",
        models: [{
          name: "glm-5",
          temperature: 0.2,
          supports_vision: true,
          input_modalities: ["image", "bogus"],
          output_modalities: "text",
        }, { name: "glm-5" }, "legacy-string"],
      } as unknown as ModelProviderConfig,
    ])).not.toThrow();
    expect(service.hasProvider("legacy-format-entry")).toBe(false);
    expect(service.hasProvider("chat")).toBe(true);
    const chat = service.getProvider("chat");
    expect(chat?.provider_type).toBe("zhipuai");
    expect(chat?.api_format).toBe("openai_proxy");
    // 水合宽松归一：旧 supports_vision 剔除、模态未知值过滤、非数组丢弃、废弃字段剥离。
    expect(chat?.models).toEqual([{ name: "glm-5", temperature: 0.2, input_modalities: ["image"] }]);
    expect(chat?.temperature).toBeUndefined();
    expect(chat?.model_map).toBeUndefined();
    expect(chat?.catalog_provider_id).toBeUndefined();
  });
});
