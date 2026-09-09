import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ModelAdapterService } from "../src/services/integrations/model-adapter-service.js";
import { runProviderFormNormalization } from "../src/services/integrations/model-adapter-hydration.js";
import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";

/**
 * Provider 形态归一层的历史形状夹具：锁住"任何历史版本的持久化条目经水合链
 * 收敛到当前形态且行为不变"。改加载逻辑弄断老用户的迁移链时，这里会先失败。
 */
describe("provider form normalization hydration", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("磁盘加载：旧别名 api_format 条目经归一存活，废弃字段剥离，字符串模型丢弃", () => {
    const yaml = [
      "alias_entry:",
      "  name: Alias Gateway",
      "  provider_type: deepseek",
      "  api_format: openai_compatible_chat",
      "  api_key: sk-legacy",
      "  temperature: 0.3",
      "  model_map:",
      "    chat: legacy-chat-model",
      "  models:",
      "    - legacy-chat-model",
      "valid_entry:",
      "  name: Current Form",
      "  provider_type: zhipuai",
      "  api_format: openai_chat",
      "  api_key: sk-current",
      "  models:",
      "    - name: glm-model",
      "      max_context_tokens: 128000",
      "      thinking_kind: effort",
    ].join("\n");
    const service = loadFromYaml(yaml);

    const alias = service.getProvider("alias_entry");
    // 旧别名归一为 openai_chat（而非被当作未知格式丢弃），废弃字段与字符串模型剥离。
    expect(alias).toMatchObject({
      name: "Alias Gateway",
      provider_type: "deepseek",
      api_format: "openai_chat",
      api_key: "sk-legacy",
      models: [],
    });
    expect(alias).not.toHaveProperty("temperature");
    expect(alias).not.toHaveProperty("model_map");

    expect(service.getProvider("valid_entry")).toMatchObject({
      api_format: "openai_chat",
      models: [{ name: "glm-model", max_context_tokens: 128000, thinking_kind: "effort" }],
    });
  });

  it("归一链幂等：已是当前形态的条目重复水合结果不变", () => {
    const config: ModelProviderConfig = {
      key: "k",
      name: "Current Form",
      provider_type: "zhipuai",
      api_format: "openai_chat",
      api_key: "sk",
      api_endpoint: "https://gw.example/v1/chat/completions",
      endpoint_mode: "full",
      models: [{ name: "glm-model", max_context_tokens: 128000, thinking_kind: "effort" }],
    };
    const snapshot = JSON.stringify(config);
    runProviderFormNormalization(config);
    runProviderFormNormalization(config);
    expect(JSON.stringify(config)).toBe(snapshot);
    expect(config.endpoint_mode).toBe("full");
  });

  it("厂商级 thinking_kind 下沉迁移：按旧运行时推断语义等价固化进条目并剥离厂商字段", () => {
    const config = (legacyKind: string | undefined, models: Array<Record<string, unknown>>, apiFormat = "openai_chat") => ({
      key: "k",
      name: "Legacy",
      provider_type: "vendor",
      api_format: apiFormat,
      api_key: "sk",
      ...(legacyKind !== undefined ? { thinking_kind: legacyKind } : {}),
      models,
    }) as unknown as ModelProviderConfig;

    // toggle + 条目 effort 子集 → effort（旧升级规则：子集是模型事实）
    expectKinds(config("toggle", [{ name: "m", thinking_levels: ["low", "high"] }]), ["effort"]);
    // anthropic + toggle 无子集 → budget（旧折叠：保护真 Anthropic/未知端点）
    expectKinds(config("toggle", [{ name: "m" }], "anthropic"), ["budget"]);
    // anthropic + toggle + 子集 → effort（旧折叠例外：openai 原生厂商挂 anthropic 兼容层）
    expectKinds(config("toggle", [{ name: "m", thinking_levels: ["high"] }], "anthropic"), ["effort"]);
    // 厂商值直通：effort/none/budget（合法格式内）
    expectKinds(config("effort", [{ name: "m" }]), ["effort"]);
    expectKinds(config("none", [{ name: "m" }]), ["none"]);
    expectKinds(config("budget", [{ name: "m" }], "anthropic"), ["budget"]);
    // 厂商缺省 → 旧格式默认（openai → effort；anthropic → budget）
    expectKinds(config(undefined, [{ name: "m" }]), ["effort"]);
    expectKinds(config(undefined, [{ name: "m" }], "anthropic"), ["budget"]);
    // openai + budget 覆盖 → none（旧 openai 线无预算通道，本就不发参数——惰性等价）
    expectKinds(config("budget", [{ name: "m" }]), ["none"]);
    // gemini → none（思考走 thinkingConfig，kind 通道恒空）
    expectKinds(config("effort", [{ name: "m" }], "gemini"), ["none"]);
    // 非法厂商值 → 按缺省下沉（openai → effort）
    expectKinds(config("bogus", [{ name: "m" }]), ["effort"]);
    // 条目已有显式声明不覆盖；仅缺失条目吃下沉值
    const mixed = config("toggle", [{ name: "declared", thinking_kind: "none" }, { name: "missing" }]) as ModelProviderConfig;
    runProviderFormNormalization(mixed);
    expect(mixed.models.map((entry) => entry.thinking_kind)).toEqual(["none", "toggle"]);
    // 厂商字段剥离（全场景）
    expect(mixed).not.toHaveProperty("thinking_kind");

    function expectKinds(input: ModelProviderConfig, expected: string[]): void {
      runProviderFormNormalization(input);
      expect(input.models.map((entry) => entry.thinking_kind)).toEqual(expected);
      expect(input).not.toHaveProperty("thinking_kind");
    }
  });

  it("迁移后条目形状损坏 → 拒载并记录 load_errors（不静默兜底）；缺失=迁移信号仍收敛", () => {
    const yaml = [
      "good:",
      "  name: Good",
      "  provider_type: zhipuai",
      "  api_format: openai_chat",
      "  api_key: sk",
      "  models:",
      "    - name: glm",
      "      thinking_kind: effort",
      "legacy_absent:",
      "  name: Legacy Absent",
      "  provider_type: moonshot",
      "  api_format: openai_chat",
      "  api_key: sk",
      "  models:",
      "    - name: kimi-k3",
      "broken_invalid:",
      "  name: Broken Invalid",
      "  provider_type: zhipuai",
      "  api_format: openai_chat",
      "  api_key: sk",
      "  models:",
      "    - name: glm",
      "      thinking_kind: efort",
      "broken_mismatch:",
      "  name: Broken Mismatch",
      "  provider_type: anthropic-gw",
      "  api_format: anthropic",
      "  api_key: sk",
      "  models:",
      "    - name: m",
      "      thinking_kind: toggle",
    ].join("\n");
    const service = loadFromYaml(yaml);

    expect(service.getProvider("good")?.models[0]?.thinking_kind).toBe("effort");
    // 无任何声明的老数据（kimi/ds 形态）：缺失 = 迁移信号，按旧格式默认收敛（可退役迁移，
    // 宣布最低支持版本后 sink 移除、缺失转为报错）
    expect(service.getProvider("legacy_absent")?.models[0]?.thinking_kind).toBe("effort");
    // 非法值（拼写错误）与格式失配（anthropic 无 toggle 通道）= 配置损坏：拒载报错
    expect(service.getProvider("broken_invalid")).toBeNull();
    expect(service.getProvider("broken_mismatch")).toBeNull();
    const loadErrors = service.listProviderLoadErrors();
    expect(loadErrors).toHaveLength(2);
    expect(loadErrors[0]).toMatchObject({ key: "broken_invalid" });
    expect(loadErrors[0]?.message).toContain("efort");
    expect(loadErrors[1]).toMatchObject({ key: "broken_mismatch" });
    expect(loadErrors[1]?.message).toContain("toggle");
    expect(loadErrors[1]?.message).toContain("anthropic");
  });

  it("运行时快照水合与磁盘水合同口径（replaceRuntimeProviders 复用同一组步骤）", () => {
    const service = new ModelAdapterService();
    service.replaceRuntimeProviders([
      {
        key: "runtime_alias",
        name: "Runtime Alias",
        provider_type: "openai_proxy",
        api_format: "openai_proxy",
        api_key: "sk",
        models: [],
      } as ModelProviderConfig,
    ]);
    expect(service.getProvider("runtime_alias")?.api_format).toBe("openai_chat");
  });

  it("headers 归一：键 trim/空白键剥、非字符串值与非法字符条目丢弃、空表剥键、占位符原样保留", () => {
    const config = {
      key: "k",
      name: "Headers Gateway",
      provider_type: "opencode",
      api_format: "openai_chat",
      api_key: "sk",
      headers: {
        "  x-opencode-session  ": "{session_id}",
        "": "dropped",
        "x-static": "tag",
        "x-number": 123,
        "x-null": null,
        // 非法字符（undici 请求构造期才抛错，归一层提前剔除防"每次调用失败"）
        "x-session id": "space-in-name",
        "x-crlf": "a\r\nb",
        "x-zh-value": "中文值",
      },
      models: [{ name: "glm-5.3", thinking_kind: "effort" }],
    } as unknown as ModelProviderConfig;
    runProviderFormNormalization(config);
    // 占位符调用期由 agent-llm 解析，归一层原样保留；非法名字/值条目丢弃
    expect(config.headers).toEqual({ "x-opencode-session": "{session_id}", "x-static": "tag" });

    const emptyHeaders = {
      key: "k2",
      name: "Empty",
      provider_type: "opencode",
      api_format: "openai_chat",
      api_key: "sk",
      headers: { "  ": "v", x: 1 },
      models: [],
    } as unknown as ModelProviderConfig;
    runProviderFormNormalization(emptyHeaders);
    expect(emptyHeaders).not.toHaveProperty("headers");

    // 非对象形状（手工编辑半迁移态）按空表收敛
    const malformed = {
      key: "k3",
      name: "Malformed",
      provider_type: "opencode",
      api_format: "openai_chat",
      api_key: "sk",
      headers: "x-opencode-session: abc",
      models: [],
    } as unknown as ModelProviderConfig;
    runProviderFormNormalization(malformed);
    expect(malformed).not.toHaveProperty("headers");
  });

  it("endpoint_mode 归一：full 非 gemini 保留；显式 base/非法值/gemini 残留剥键回落基座语义", () => {
    const yaml = [
      "full_mode:",
      "  name: Full Mode",
      "  provider_type: zhipuai",
      "  api_format: openai_chat",
      "  api_key: sk",
      "  api_endpoint: https://gw.example/v1/chat/completions",
      "  endpoint_mode: full",
      "  models:",
      "    - name: glm",
      "      thinking_kind: effort",
      "explicit_base:",
      "  name: Explicit Base",
      "  provider_type: deepseek",
      "  api_format: openai_chat",
      "  api_key: sk",
      "  endpoint_mode: base",
      "  models:",
      "    - name: ds",
      "      thinking_kind: effort",
      "invalid_value:",
      "  name: Invalid Value",
      "  provider_type: deepseek",
      "  api_format: openai_chat",
      "  api_key: sk",
      "  endpoint_mode: weird",
      "  models:",
      "    - name: ds",
      "      thinking_kind: effort",
      "gemini_full:",
      "  name: Gemini Full",
      "  provider_type: google",
      "  api_format: gemini",
      "  api_key: sk",
      "  endpoint_mode: full",
      "  models:",
      "    - name: gem",
      "      thinking_kind: none",
    ].join("\n");
    const service = loadFromYaml(yaml);

    // full = 完整方法 URL 直用的显式声明，保留落盘
    expect(service.getProvider("full_mode")?.endpoint_mode).toBe("full");
    // base 是缺省语义不落盘；非法值/手工编辑半迁移态收敛剥弃（与 headers 同策略）
    expect(service.getProvider("explicit_base")).not.toHaveProperty("endpoint_mode");
    expect(service.getProvider("invalid_value")).not.toHaveProperty("endpoint_mode");
    // gemini 不适用（URL 由 SDK 按模型名拼装），残留剥弃
    expect(service.getProvider("gemini_full")).not.toHaveProperty("endpoint_mode");
  });

  function loadFromYaml(yaml: string): ModelAdapterService {
    const dir = mkdtempSync(path.join(tmpdir(), "provider-hydration-"));
    tempDirs.push(dir);
    const configPath = path.join(dir, "providers.yaml");
    writeFileSync(configPath, yaml, "utf8");
    return new ModelAdapterService({ providersConfigPath: configPath });
  }
});
