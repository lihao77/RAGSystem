import assert from "node:assert/strict";
import test from "node:test";

import { buildThinkingParams, describeThinking, effectiveReasoningEffort, effectiveThinkingBudget } from "../dist/thinking.js";
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
  assert.deepEqual(describeThinking("openai_chat").levels, ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("openai_resp").levels, ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("anthropic").levels, ["off", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("gemini").levels, []);
  // 厂商差异经 provider 的 thinking_kind 声明（如 qwen 系 enable_thinking），本包不认识厂商
  assert.equal(describeThinking("openai_chat", "toggle").kind, "toggle");
  assert.deepEqual(describeThinking("openai_chat", "toggle").levels, ["off", "on"]);
  assert.equal(describeThinking("openai_chat", "none").kind, "none");
  assert.deepEqual(describeThinking("openai_chat", "none").levels, []);
});

test("effort 档位顶层 reasoning_effort 直通（off 显式 none）", () => {
  assert.deepEqual(buildThinkingParams(provider("openai_chat"), "low"), { reasoning_effort: "low" });
  assert.deepEqual(buildThinkingParams(provider("openai_chat"), "high"), { reasoning_effort: "high" });
  assert.deepEqual(buildThinkingParams(provider("openai_chat"), "off"), { reasoning_effort: "none" });
  assert.deepEqual(buildThinkingParams(provider("openai_chat"), "minimal"), { reasoning_effort: "minimal" });
});

test("无档位一律返回 null（档位只来自请求级/tier 配置，provider 不定义思考）", () => {
  assert.equal(buildThinkingParams(provider("openai_chat")), null);
  assert.equal(buildThinkingParams(provider("openai_chat", { reasoning_effort: "high" })), null);
  assert.equal(buildThinkingParams(provider("openai_chat")), null);
  assert.equal(buildThinkingParams(provider("openai_chat", { thinking_kind: "toggle" })), null);
  assert.equal(buildThinkingParams(provider("anthropic"), "high"), null);
});

test("toggle 形状（厂商 thinking_kind 声明）：on 开启 / off 关闭", () => {
  assert.deepEqual(buildThinkingParams(provider("openai_chat", { thinking_kind: "toggle" }), "on"), { enable_thinking: true });
  assert.deepEqual(buildThinkingParams(provider("openai_chat", { thinking_kind: "toggle" }), "off"), { enable_thinking: false });
  assert.equal(buildThinkingParams(provider("openai_chat", { thinking_kind: "toggle" })), null);
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
  assert.throws(() => buildThinkingParams(provider("openai_chat", { thinking_kind: "toggle" }), "medium"), /not supported/);
});

test("模型级 thinking_levels 子集替换强度档位（目录厂商枚举为准；off 恒可用）", () => {
  // deepseek 风格：low/high/max
  const ds = provider("openai_chat", { thinking_levels: ["low", "high", "max"] });
  assert.deepEqual(describeThinking("openai_chat", undefined, ["low", "high", "max"]).levels, ["off", "low", "high", "max"]);
  assert.deepEqual(buildThinkingParams(ds, "max"), { reasoning_effort: "max" });
  assert.deepEqual(buildThinkingParams(ds, "off"), { reasoning_effort: "none" });
  assert.throws(() => buildThinkingParams(ds, "medium"), /not supported/);
  assert.throws(() => buildThinkingParams(ds, "minimal"), /not supported/);
  // 子集是模型真实值域，可含格式默认集没有的档位（max 不在 openai_chat 默认菜单）
  assert.deepEqual(describeThinking("openai_chat", undefined, ["high", "max"]).levels, ["off", "high", "max"]);
});

test("toggle 厂商下模型级 effort 值域升级为 effort 分级（厂商投票只描述多数默认）", () => {
  // 智谱场景：厂商 thinking_kind=toggle（多数 GLM 是纯开关），glm-5.3 自带 low/high/max
  const glm = provider("openai_chat", { thinking_kind: "toggle", thinking_levels: ["low", "high", "max"] });
  assert.deepEqual(describeThinking("openai_chat", "toggle", ["low", "high", "max"]), {
    kind: "effort",
    levels: ["off", "low", "high", "max"],
  });
  assert.deepEqual(buildThinkingParams(glm, "high"), { reasoning_effort: "high" });
  assert.deepEqual(buildThinkingParams(glm, "off"), { reasoning_effort: "none" });
  // 升级后 on 不再是合法档位（陈旧配置不得静默下发）
  assert.throws(() => buildThinkingParams(glm, "on"), /not supported/);
  // 无子集/空子集/全非法子集 → 维持开关形状
  assert.deepEqual(describeThinking("openai_chat", "toggle", undefined).levels, ["off", "on"]);
  assert.deepEqual(describeThinking("openai_chat", "toggle", []).levels, ["off", "on"]);
  assert.deepEqual(describeThinking("openai_chat", "toggle", ["bogus"]).levels, ["off", "on"]);
  assert.deepEqual(buildThinkingParams(provider("openai_chat", { thinking_kind: "toggle" }), "on"), { enable_thinking: true });
});

test("budget 形状菜单随模型子集收缩（子集是模型事实；空/坏子集 = 格式默认集）", () => {
  // budget：模型子集（effort 值域）收缩档位菜单，档位按预算阶梯映射
  assert.deepEqual(describeThinking("anthropic", undefined, ["low"]).levels, ["off", "low"]);
  assert.equal(effectiveThinkingBudget(provider("anthropic", { thinking_levels: ["low"] }), "low"), 4096);
  assert.throws(() => effectiveThinkingBudget(provider("anthropic", { thinking_levels: ["low"] }), "high"), /not supported/);
  assert.deepEqual(describeThinking("openai_chat", undefined, []).levels, ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("openai_chat", undefined, "low").levels, ["off", "minimal", "low", "medium", "high"]);
  // 非法值过滤；全非法 → 回退格式默认集
  assert.deepEqual(describeThinking("openai_chat", undefined, ["high", "bogus"]).levels, ["off", "high"]);
  assert.deepEqual(describeThinking("openai_chat", undefined, ["bogus"]).levels, ["off", "minimal", "low", "medium", "high"]);
});

test("budget 形状覆盖到 openai 系格式时默认菜单同预设集，子集收缩与 anthropic 同型", () => {
  assert.deepEqual(describeThinking("openai_chat", "budget").levels, ["off", "low", "medium", "high"]);
  // 子集（effort 值域）是模型事实，budget 菜单同样收缩
  assert.deepEqual(describeThinking("openai_chat", "budget", ["low"]).levels, ["off", "low"]);
});

test("anthropic 不出 thinking 参数（budget 由 anthropic 适配器专用路径消费）", () => {
  assert.equal(buildThinkingParams(provider("anthropic"), "high"), null);
  assert.equal(effectiveThinkingBudget(provider("anthropic"), "high"), 32768);
  assert.throws(() => effectiveThinkingBudget(provider("anthropic"), "max"), /not supported/);
});

test("anthropic toggle+模型 effort 子集自动升级 effort（openai 原生厂商挂 anthropic 兼容端点）", () => {
  // pqy 形状（厂商投票 toggle + glm 分级子集）：toggle 只可能来自 openai 原生厂商的目录投票，
  // 该类厂商挂 anthropic 端点必是兼容层（budget_tokens 被无视、档位制）——与 openai 升级同型；
  // 原事故（升级后无人消费静默失效）已由 anthropic 适配器的 output_config.effort 通道修复。
  const pqy = provider("anthropic", { thinking_kind: "toggle", thinking_levels: ["low", "high", "max"] });
  assert.deepEqual(describeThinking("anthropic", "toggle", ["low", "high", "max"]), { kind: "effort", levels: ["off", "low", "high", "max"] });
  assert.equal(effectiveReasoningEffort(pqy, "max"), "max");
  assert.equal(effectiveReasoningEffort(pqy, "high"), "high");
  assert.equal(effectiveReasoningEffort(pqy, "low"), "low");
  assert.equal(effectiveReasoningEffort(pqy, "off"), "none");
  assert.equal(effectiveThinkingBudget(pqy, "max"), undefined);
  assert.deepEqual(buildThinkingParams(pqy, "max"), { reasoning_effort: "max" });
});

test("anthropic 其余形状折叠 budget（默认/无子集 toggle/未知端点保护真 Anthropic）", () => {
  // 无声明 + 子集（ds-anthropic/kimi yaml 形态）：折叠 budget，max 可选——原 not-supported 抛错
  assert.equal(effectiveThinkingBudget(provider("anthropic", { thinking_levels: ["low", "high", "max"] }), "max"), 65536);
  // 阶梯全覆盖：minimal/xhigh 档位有预算落点
  assert.equal(effectiveThinkingBudget(provider("anthropic", { thinking_levels: ["minimal", "xhigh"] }), "minimal"), 2048);
  assert.equal(effectiveThinkingBudget(provider("anthropic", { thinking_levels: ["minimal", "xhigh"] }), "xhigh"), 49152);
  // toggle 无子集（openai 原生厂商的 toggle-only 模型，无 effort 值域可升级）：折叠 budget 默认菜单
  assert.deepEqual(describeThinking("anthropic", "toggle"), { kind: "budget", levels: ["off", "low", "medium", "high"] });
  assert.equal(effectiveThinkingBudget(provider("anthropic", { thinking_kind: "toggle" }), "high"), 32768);
  // 显式 none 保留：无菜单无参数
  assert.deepEqual(describeThinking("anthropic", "none"), { kind: "none", levels: [] });
  assert.equal(buildThinkingParams(provider("anthropic", { thinking_kind: "none" }), "high"), null);
});

test("anthropic 折叠后档位预算端到端下发（buildAnthropicBody）", () => {
  // 无声明 + 子集（ds-anthropic/kimi yaml 形态）：budget 折叠，档位按预算阶梯映射
  const budgeted = provider("anthropic", { thinking_levels: ["low", "high", "max"] });
  const body = buildAnthropicBody(request(budgeted, "max", { maxCompletionTokens: 131072 }));
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 65536 });
  assert.equal(body.max_tokens, 131072);
  assert.equal(body.temperature, undefined);
  const clamped = buildAnthropicBody(request(budgeted, "max", { maxCompletionTokens: 8192 }));
  assert.deepEqual(clamped.thinking, { type: "enabled", budget_tokens: 8191 });
  assert.equal(clamped.max_tokens, 8192);
});

test("anthropic toggle+子集升级后档位端到端下发（pqy 形状：output_config.effort 通道）", () => {
  const pqy = provider("anthropic", { thinking_kind: "toggle", thinking_levels: ["low", "high", "max"] });
  const body = buildAnthropicBody(request(pqy, "max", { maxCompletionTokens: 131072 }));
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.deepEqual(body.output_config, { effort: "max" });
  assert.equal("budget_tokens" in body.thinking, false);
  assert.equal(body.max_tokens, 131072);
  assert.equal(body.temperature, undefined);
});

test("anthropic 显式 effort 声明保形：effort 型兼容端点档位落 output_config.effort（端到端）", () => {
  // 智谱/Kimi/阿里/火山等 /v1/messages 网关：budget_tokens 被无视，档位唯一落点 output_config.effort
  const pqy = provider("anthropic", { thinking_kind: "effort", thinking_levels: ["low", "high", "max"] });
  assert.deepEqual(describeThinking("anthropic", "effort", ["low", "high", "max"]), { kind: "effort", levels: ["off", "low", "high", "max"] });
  // 无子集：effort 形状默认阶梯（与 API 格式无关）
  assert.deepEqual(describeThinking("anthropic", "effort"), { kind: "effort", levels: ["off", "minimal", "low", "medium", "high"] });
  assert.equal(effectiveReasoningEffort(pqy, "max"), "max");
  assert.equal(effectiveReasoningEffort(pqy, "low"), "low");
  assert.equal(effectiveReasoningEffort(pqy, "off"), "none");
  assert.equal(effectiveThinkingBudget(pqy, "max"), undefined);
  // buildThinkingParams 形状通用（openai-chat 消费；anthropic 走适配器专用路径）
  assert.deepEqual(buildThinkingParams(pqy, "max"), { reasoning_effort: "max" });

  const body = buildAnthropicBody(request(pqy, "max", { maxCompletionTokens: 131072, temperature: 0.7 }));
  assert.deepEqual(body.thinking, { type: "enabled" }); // 不带 budget_tokens：该类端点无视预算
  assert.deepEqual(body.output_config, { effort: "max" });
  assert.equal(body.max_tokens, 131072);
  assert.equal(body.temperature, undefined); // 思考开启时省略（该类端点思考态忽略采样参数）
  const low = buildAnthropicBody(request(pqy, "low", { maxCompletionTokens: 8192 }));
  assert.deepEqual(low.thinking, { type: "enabled" });
  assert.deepEqual(low.output_config, { effort: "low" });
  assert.equal("budget_tokens" in low.thinking, false);
  assert.equal(low.max_tokens, 8192); // effort 形状无预算钳制/抬高（那是 budget 形状专属）
  // off：关闭语义在该类端点无处落点（多数模型思考强制开启），降级为不发字段 = 模型默认
  const off = buildAnthropicBody(request(pqy, "off", { temperature: 0.7 }));
  assert.equal("thinking" in off, false);
  assert.equal("output_config" in off, false);
  assert.equal(off.temperature, 0.7);
  assert.equal(off.max_tokens, 4096);
});

test("buildChatBody 合并档位参数与厂商 extra_params（嵌套思考形状由厂商层静态带入）", () => {
  const body = buildChatBody(request(provider("openai_chat"), "high", { extraParams: { thinking: { type: "enabled" } } }));
  assert.equal(body.model, "test-model");
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "high");
});

test("openai_chat 统一使用 max_completion_tokens 现代字段（不按格式/思考特判）", () => {
  const body = buildChatBody(request(provider("openai_chat"), "high", { maxCompletionTokens: 2048 }));
  assert.equal(body.max_completion_tokens, 2048);
  assert.equal(body.max_tokens, undefined);
  const withoutEffort = buildChatBody(request(provider("openai_chat"), undefined, { maxCompletionTokens: 2048 }));
  assert.equal(withoutEffort.max_completion_tokens, 2048);
  assert.equal(withoutEffort.max_tokens, undefined);
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
