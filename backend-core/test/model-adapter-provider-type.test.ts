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
  models: [{ name: "gpt-4.1", thinking_kind: "effort" }],
};

describe("ModelAdapterService provider configuration (provider_type=厂商, api_format=API 格式)", () => {
  it("listApiFormats 暴露封闭的 4 种纯协议格式（无厂商类型；openai_proxy 已并入 openai_chat）", () => {
    const formats = new ModelAdapterService().listApiFormats();
    expect(formats.map((item) => item.value)).toEqual(["openai_resp", "openai_chat", "anthropic", "gemini"]);
    const fields = (apiFormat: string) => formats.find((item) => item.value === apiFormat)?.config_fields ?? [];
    expect(fields("anthropic").some((field) => field.key === "supports_prompt_caching")).toBe(true);
    for (const apiFormat of ["gemini", "openai_chat", "openai_resp"]) {
      expect(fields(apiFormat).some((field) => field.key === "supports_prompt_caching")).toBe(false);
    }
    expect(fields("anthropic").some((field) => field.key === "cache_ttl_seconds")).toBe(true);
    expect(fields("gemini").some((field) => field.key === "cache_ttl_seconds")).toBe(false);
    expect(formats.find((item) => item.value === "openai_chat")?.default_endpoint).toBe("https://api.openai.com/v1");
  });

  it("update 可切换 API 格式与厂商（自由字符串）；厂商级 thinking_kind 已退役（payload 忽略），条目形状失配报 400", () => {
    const service = new ModelAdapterService();
    const result = service.buildUpdateProvider("stable-provider-key", existing, {
      api_format: "anthropic",
      api_endpoint: "https://api.anthropic.com",
    });
    expect(result.key).toBe("stable-provider-key");
    expect(result.config.api_format).toBe("anthropic");
    expect(result.config.provider_type).toBe("openai");
    // 条目 effort 在 anthropic 线合法（effort 型兼容端点），跨格式切换随行

    const rebranded = service.buildUpdateProvider("stable-provider-key", result.config, {
      provider_type: " ZhipuAi ",
      // 厂商级字段已退役：UPDATE_FIELDS 不含，payload 携带也不落盘（思考形状在模型条目上）
      thinking_kind: " TOGGLE ",
    });
    expect(rebranded.config.provider_type).toBe("zhipuai");
    expect(rebranded.config.api_format).toBe("anthropic");
    expect((rebranded.config as Record<string, unknown>).thinking_kind).toBeUndefined();

    // 跨字段失配：条目 effort 切到 gemini（仅 none）→ 终局校验 400 报错不静默
    expect(() => service.buildUpdateProvider("stable-provider-key", rebranded.config, { api_format: "gemini" }))
      .toThrowError(new ModelAdapterServiceError('模型 "gpt-4.1" 的 thinking_kind "effort" 在 API 格式 "gemini" 下不可用（可选: none）', 400));
  });

  it("rejects unknown or missing api formats (厂商自由、格式封闭)", () => {
    const service = new ModelAdapterService();
    expect(() => service.buildUpdateProvider("stable-provider-key", existing, { api_format: "unsupported-format" }))
      .toThrowError(new ModelAdapterServiceError("不支持的 API 格式: unsupported-format", 400));
    expect(() => service.buildUpdateProvider("stable-provider-key", existing, { api_format: "" }))
      .toThrowError(new ModelAdapterServiceError("不支持的 API 格式: (空)", 400));

    const base = { name: "Zhipu", provider_type: "zhipuai", api_key: "secret" };
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "glm-5", thinking_kind: "effort" }] }))
      .toThrowError(new ModelAdapterServiceError("缺少必需字段: api_format", 400));
    expect(() => service.buildCreateProvider({ ...base, api_format: "openai_native", models: [{ name: "glm-5", thinking_kind: "effort" }] }))
      .toThrowError(new ModelAdapterServiceError("不支持的 API 格式: openai_native", 400));
    // api_format 别名归一：openai_compatible_chat/openai_proxy → openai_chat、openai → openai_chat（厂商不受影响）。
    const aliased = service.buildCreateProvider({
      ...base,
      api_format: "openai_compatible_chat",
      api_endpoint: "https://open.bigmodel.cn/api/paas/v4",
      models: [{ name: "glm-5", thinking_kind: "effort" }],
    });
    expect(aliased.config.api_format).toBe("openai_chat");
    expect(aliased.config.provider_type).toBe("zhipuai");
    const openaiAlias = service.buildCreateProvider({
      name: "OpenAI", provider_type: "openai", api_key: "secret", api_format: "openai",
      models: [{ name: "gpt-4.1", thinking_kind: "effort" }],
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
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "gpt-4.1", thinking_levels: "low", thinking_kind: "effort" }] }))
      .toThrowError(new ModelAdapterServiceError("思考档位必须是数组", 400));
    // 思考形状写入面必达：缺失 / 非法值 / 格式失配 → 400 报错（不静默填充）
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "gpt-4.1" }] }))
      .toThrowError(new ModelAdapterServiceError('模型 "gpt-4.1" 缺少 thinking_kind 声明（thinking shape is required per model entry）', 400));
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "gpt-4.1", thinking_kind: "efort" }] }))
      .toThrowError(new ModelAdapterServiceError('模型 "gpt-4.1" 的 thinking_kind "efort" 非法（合法值: effort/budget/toggle/none）', 400));
    expect(() => service.buildCreateProvider({ ...base, models: [{ name: "gpt-4.1", thinking_kind: "budget" }] }))
      .toThrowError(new ModelAdapterServiceError('模型 "gpt-4.1" 的 thinking_kind "budget" 在 API 格式 "openai_chat" 下不可用（可选: effort/toggle/none）', 400));

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
        thinking_kind: " effort ",
        // 思考线字段声明：白名单两值，非法值静默丢弃
        reasoning_field: "reasoning_details",
        custom_key: "dropped",
      }, {
        name: "bad-field-model",
        reasoning_field: "reasoning",
        thinking_kind: "none",
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
        thinking_kind: "effort",
        reasoning_field: "reasoning_details",
      },
      { name: "bad-field-model", thinking_kind: "none" },
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
      models: [{ name: "gpt-4.1-mini", max_completion_tokens: 8192, thinking_kind: "effort" }, { name: "o4-mini", thinking_kind: "toggle" }],
    });
    expect(result.config.models).toEqual([
      { name: "gpt-4.1-mini", max_completion_tokens: 8192, thinking_kind: "effort" },
      { name: "o4-mini", thinking_kind: "toggle" },
    ]);

    const untouched = service.buildUpdateProvider("stable-provider-key", existing, { timeout: 60 });
    expect(untouched.config.models).toEqual([{ name: "gpt-4.1", thinking_kind: "effort" }]);
  });

  it("provider 级自定义请求头：create/update 往返、键 trim、占位符原样落盘、非法形状 400、空表/null 清空", () => {
    const service = new ModelAdapterService();
    const created = service.buildCreateProvider({
      name: "OpenCode Go",
      provider_type: "opencode",
      api_format: "openai_chat",
      api_key: "sk",
      api_endpoint: "https://opencode.ai/zen/go/v1",
      headers: { "x-opencode-session": "{session_id}", "  session_id  ": "static" },
      models: [{ name: "glm-5.3", thinking_kind: "effort" }],
    });
    // {session_id} 占位符调用期由 agent-llm 解析，配置层原样保留；键 trim 归一。
    expect(created.config.headers).toEqual({ "x-opencode-session": "{session_id}", session_id: "static" });

    // update 未提供 headers 时保留原值；提供则整体替换
    const untouched = service.buildUpdateProvider("stable-provider-key", existing, { timeout: 60 });
    expect(untouched.config.headers).toBeUndefined();
    const withHeaders = { ...existing, headers: { "x-a": "1" } };
    const updated = service.buildUpdateProvider("stable-provider-key", withHeaders, {
      headers: { "x-opencode-session": "{session_id}" },
    });
    expect(updated.config.headers).toEqual({ "x-opencode-session": "{session_id}" });

    // 写入面严格形状（400 不静默丢弃）：非字符串值 / 非对象
    const malformedError = new ModelAdapterServiceError("自定义请求头必须是字符串键值表（headers: Record<string, string>）", 400);
    expect(() => service.buildUpdateProvider("stable-provider-key", existing, { headers: { "x-a": 1 } }))
      .toThrowError(malformedError);
    expect(() => service.buildCreateProvider({
      name: "X", provider_type: "x", api_format: "openai_chat", api_key: "sk",
      headers: "x-a: 1", models: [{ name: "m", thinking_kind: "effort" }],
    })).toThrowError(malformedError);
    // 非法字符（名字含空格/CRLF、值含换行或非 latin1）同样 400——undici 在请求构造期
    // 才拦截，配置期拦下防"每次 LLM 调用失败且报错像连接错误"
    expect(() => service.buildUpdateProvider("stable-provider-key", existing, { headers: { "x-session id": "v" } }))
      .toThrowError(new ModelAdapterServiceError('自定义请求头 "x-session id" 含非法字符（名字须 RFC 7230 token、值须可打印字符，不含换行）', 400));
    expect(() => service.buildUpdateProvider("stable-provider-key", existing, { headers: { "x-a": "a\r\nb" } }))
      .toThrowError(new ModelAdapterServiceError('自定义请求头 "x-a" 含非法字符（名字须 RFC 7230 token、值须可打印字符，不含换行）', 400));
    expect(() => service.buildCreateProvider({
      name: "X", provider_type: "x", api_format: "openai_chat", api_key: "sk",
      headers: { "x-zh": "中文值" }, models: [{ name: "m", thinking_kind: "effort" }],
    })).toThrowError(new ModelAdapterServiceError('自定义请求头 "x-zh" 含非法字符（名字须 RFC 7230 token、值须可打印字符，不含换行）', 400));

    // null / 空表 = 清空入口（归一后剥键，不落空对象）
    const cleared = service.buildUpdateProvider("stable-provider-key", withHeaders, { headers: null });
    expect(cleared.config).not.toHaveProperty("headers");
    const emptied = service.buildUpdateProvider("stable-provider-key", withHeaders, { headers: {} });
    expect(emptied.config).not.toHaveProperty("headers");
  });

  it("availability 以 api_format + models 判定", () => {
    const service = new ModelAdapterService();
    service.createProvider({
      name: "Zhipu",
      provider_type: "zhipuai",
      api_format: "openai_proxy",
      api_key: "secret",
      api_endpoint: "https://open.bigmodel.cn/api/paas/v4",
      models: [{ name: "glm-5", thinking_kind: "effort" }],
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
    expect(chat?.api_format).toBe("openai_chat");
    // 水合宽松归一：旧 supports_vision 剔除、模态未知值过滤、非数组丢弃、废弃字段剥离；
    // 条目缺形状 = 迁移信号，加载链按旧格式默认下沉（openai_chat → effort）。
    expect(chat?.models).toEqual([{ name: "glm-5", temperature: 0.2, input_modalities: ["image"], thinking_kind: "effort" }]);
    expect(chat?.temperature).toBeUndefined();
    expect(chat?.model_map).toBeUndefined();
    expect(chat?.catalog_provider_id).toBeUndefined();
  });
});
