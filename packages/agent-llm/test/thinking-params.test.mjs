import assert from "node:assert/strict";
import test from "node:test";

import { buildThinkingParams, describeThinking, effectiveThinkingBudget } from "../dist/thinking.js";
import { buildAnthropicBody } from "../dist/providers/anthropic.js";
import { buildChatBody } from "../dist/providers/openai-chat.js";

const provider = (providerType, extra = {}) => ({
  key: "test",
  name: "test",
  provider_type: providerType,
  api_key: "k",
  ...extra,
});

const request = (providerConfig, thinkingLevel, extra = {}) => ({
  provider: providerConfig,
  model: "test-model",
  messages: [{ role: "user", content: "hi" }],
  ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  ...extra,
});

test("档位集合按 API 格式返回（describeThinking）；thinking_kind 覆盖形状（厂商层适配）", () => {
  assert.deepEqual(describeThinking("openai_chat").levels, ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("openai_proxy").levels, ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("openai_resp").levels, ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("anthropic").levels, ["off", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("gemini").levels, []);
  // 厂商差异经 provider 的 thinking_kind 声明（如 qwen 系 enable_thinking），本包不认识厂商
  assert.equal(describeThinking("openai_proxy", "toggle").kind, "toggle");
  assert.deepEqual(describeThinking("openai_proxy", "toggle").levels, ["off", "on"]);
  assert.equal(describeThinking("openai_proxy", "none").kind, "none");
  assert.deepEqual(describeThinking("openai_proxy", "none").levels, []);
});

test("effort 档位顶层 reasoning_effort 直通（off 显式 none）", () => {
  assert.deepEqual(buildThinkingParams(provider("openai_proxy"), "low"), { reasoning_effort: "low" });
  assert.deepEqual(buildThinkingParams(provider("openai_proxy"), "high"), { reasoning_effort: "high" });
  assert.deepEqual(buildThinkingParams(provider("openai_proxy"), "off"), { reasoning_effort: "none" });
  assert.deepEqual(buildThinkingParams(provider("openai_chat"), "minimal"), { reasoning_effort: "minimal" });
});

test("无档位一律返回 null（档位只来自请求级/tier 配置，provider 不定义思考）", () => {
  assert.equal(buildThinkingParams(provider("openai_proxy")), null);
  assert.equal(buildThinkingParams(provider("openai_proxy", { reasoning_effort: "high" })), null);
  assert.equal(buildThinkingParams(provider("openai_chat")), null);
  assert.equal(buildThinkingParams(provider("openai_proxy", { thinking_kind: "toggle" })), null);
  assert.equal(buildThinkingParams(provider("anthropic"), "high"), null);
});

test("toggle 形状（厂商 thinking_kind 声明）：on 开启 / off 关闭", () => {
  assert.deepEqual(buildThinkingParams(provider("openai_proxy", { thinking_kind: "toggle" }), "on"), { enable_thinking: true });
  assert.deepEqual(buildThinkingParams(provider("openai_proxy", { thinking_kind: "toggle" }), "off"), { enable_thinking: false });
  assert.equal(buildThinkingParams(provider("openai_proxy", { thinking_kind: "toggle" })), null);
});

test("openai_chat 顶层 reasoning_effort 直通档位（minimal/off），越界档位拒绝", () => {
  assert.deepEqual(buildThinkingParams(provider("openai_chat"), "minimal"), { reasoning_effort: "minimal" });
  assert.deepEqual(buildThinkingParams(provider("openai_chat"), "off"), { reasoning_effort: "none" });
  assert.equal(buildThinkingParams(provider("openai_chat")), null);
  assert.throws(() => buildThinkingParams(provider("openai_chat"), "xhigh"), /not supported/);
  assert.throws(() => buildThinkingParams(provider("openai_chat"), "max"), /not supported/);
});

test("超出声明子集的档位拒绝，不静默下发", () => {
  assert.throws(() => buildThinkingParams(provider("openai_chat"), "on"), /not supported/);
  assert.throws(() => buildThinkingParams(provider("openai_proxy", { thinking_kind: "toggle" }), "medium"), /not supported/);
});

test("模型级 thinking_levels 子集替换强度档位（目录厂商枚举为准；off 恒可用）", () => {
  // deepseek 风格：low/high/max
  const ds = provider("openai_proxy", { thinking_levels: ["low", "high", "max"] });
  assert.deepEqual(describeThinking("openai_proxy", undefined, ["low", "high", "max"]).levels, ["off", "low", "high", "max"]);
  assert.deepEqual(buildThinkingParams(ds, "max"), { reasoning_effort: "max" });
  assert.deepEqual(buildThinkingParams(ds, "off"), { reasoning_effort: "none" });
  assert.throws(() => buildThinkingParams(ds, "medium"), /not supported/);
  assert.throws(() => buildThinkingParams(ds, "minimal"), /not supported/);
  // 子集是模型真实值域，可含格式默认集没有的档位（max 不在 openai_chat 默认菜单）
  assert.deepEqual(describeThinking("openai_chat", undefined, ["high", "max"]).levels, ["off", "high", "max"]);
});

test("toggle 厂商下模型级 effort 值域升级为 effort 分级（厂商投票只描述多数默认）", () => {
  // 智谱场景：厂商 thinking_kind=toggle（多数 GLM 是纯开关），glm-5.3 自带 low/high/max
  const glm = provider("openai_proxy", { thinking_kind: "toggle", thinking_levels: ["low", "high", "max"] });
  assert.deepEqual(describeThinking("openai_proxy", "toggle", ["low", "high", "max"]), {
    kind: "effort",
    levels: ["off", "low", "high", "max"],
  });
  assert.deepEqual(buildThinkingParams(glm, "high"), { reasoning_effort: "high" });
  assert.deepEqual(buildThinkingParams(glm, "off"), { reasoning_effort: "none" });
  // 升级后 on 不再是合法档位（陈旧配置不得静默下发）
  assert.throws(() => buildThinkingParams(glm, "on"), /not supported/);
  // 无子集/空子集/全非法子集 → 维持开关形状
  assert.deepEqual(describeThinking("openai_proxy", "toggle", undefined).levels, ["off", "on"]);
  assert.deepEqual(describeThinking("openai_proxy", "toggle", []).levels, ["off", "on"]);
  assert.deepEqual(describeThinking("openai_proxy", "toggle", ["bogus"]).levels, ["off", "on"]);
  assert.deepEqual(buildThinkingParams(provider("openai_proxy", { thinking_kind: "toggle" }), "on"), { enable_thinking: true });
});

test("子集对 budget 形状与非法值不生效（budget 预设不收缩；空/坏子集 = 格式默认集）", () => {
  // budget：档位是本包预设，模型子集（effort 语义）不约束
  assert.equal(effectiveThinkingBudget(provider("anthropic", { thinking_levels: ["low"] }), "high"), 32768);
  assert.deepEqual(describeThinking("openai_chat", undefined, []).levels, ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("openai_chat", undefined, "low").levels, ["off", "minimal", "low", "medium", "high"]);
  // 非法值过滤；全非法 → 回退格式默认集
  assert.deepEqual(describeThinking("openai_chat", undefined, ["high", "bogus"]).levels, ["off", "high"]);
  assert.deepEqual(describeThinking("openai_chat", undefined, ["bogus"]).levels, ["off", "minimal", "low", "medium", "high"]);
});

test("budget 形状覆盖到 openai 系格式时档位用预算预设集（不含 minimal 等无预设档位）", () => {
  assert.deepEqual(describeThinking("openai_chat", "budget").levels, ["off", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("openai_proxy", "budget").levels, ["off", "low", "medium", "high"]);
  // 子集（effort 语义）对 budget 形状依旧不生效
  assert.deepEqual(describeThinking("openai_proxy", "budget", ["low"]).levels, ["off", "low", "medium", "high"]);
});

test("anthropic 不出 thinking 参数（budget 由 anthropic 适配器专用路径消费）", () => {
  assert.equal(buildThinkingParams(provider("anthropic"), "high"), null);
  assert.equal(effectiveThinkingBudget(provider("anthropic"), "high"), 32768);
  assert.throws(() => effectiveThinkingBudget(provider("anthropic"), "max"), /not supported/);
});

test("buildChatBody 合并档位参数与厂商 extra_params（嵌套思考形状由厂商层静态带入）", () => {
  const body = buildChatBody(request(provider("openai_proxy"), "high", { extraParams: { thinking: { type: "enabled" } } }));
  assert.equal(body.model, "test-model");
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
});

test("openai_chat 开启思考时仍使用 max_completion_tokens 现代字段", () => {
  const body = buildChatBody(request(provider("openai_chat"), "high", { maxCompletionTokens: 2048 }));
  assert.equal(body.max_completion_tokens, 2048);
  assert.equal(body.max_tokens, undefined);
  const legacy = buildChatBody(request(provider("openai_chat"), undefined, { maxCompletionTokens: 2048 }));
  assert.equal(legacy.max_tokens, 2048);
  assert.equal(legacy.max_completion_tokens, undefined);
});

test("anthropic 适配器保证 budget_tokens 严格小于 max_tokens", () => {
  const unconfigured = buildAnthropicBody(request(provider("anthropic"), "high"));
  assert.equal(unconfigured.max_tokens, 32768 + 1024);
  assert.deepEqual(unconfigured.thinking, { type: "enabled", budget_tokens: 32768 });

  const capped = buildAnthropicBody(request(provider("anthropic"), "high", { maxCompletionTokens: 16384 }));
  assert.equal(capped.max_tokens, 16384);
  assert.deepEqual(capped.thinking, { type: "enabled", budget_tokens: 16383 });

  const off = buildAnthropicBody(request(provider("anthropic"), "off"));
  assert.equal(off.max_tokens, 4096);
  assert.equal("thinking" in off, false);
});
