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

test("档位集合按厂商枚举返回（describeThinking）", () => {
  assert.deepEqual(describeThinking("openai_chat").levels, ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("deepseek").levels, ["off", "low", "high", "max"]);
  assert.deepEqual(describeThinking("openrouter").levels, ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(describeThinking("anthropic").levels, ["off", "low", "medium", "high"]);
  assert.deepEqual(describeThinking("modelscope").levels, ["off", "on"]);
  assert.deepEqual(describeThinking("rerank_api").levels, []);
});

test("deepseek 档位序列化为 thinking map（off 显式 disabled，max 直通）", () => {
  assert.deepEqual(buildThinkingParams(provider("deepseek"), "low"), {
    thinking: { type: "enabled", reasoning_effort: "low" },
  });
  assert.deepEqual(buildThinkingParams(provider("deepseek"), "high"), {
    thinking: { type: "enabled", reasoning_effort: "high" },
  });
  assert.deepEqual(buildThinkingParams(provider("deepseek"), "max"), {
    thinking: { type: "enabled", reasoning_effort: "max" },
  });
  assert.deepEqual(buildThinkingParams(provider("deepseek"), "off"), {
    thinking: { type: "disabled" },
  });
});

test("无档位一律返回 null（档位只来自请求级/tier 配置，provider 不定义思考）", () => {
  assert.equal(buildThinkingParams(provider("deepseek")), null);
  assert.equal(buildThinkingParams(provider("deepseek", { reasoning_effort: "high" })), null);
  assert.equal(buildThinkingParams(provider("openrouter")), null);
  assert.equal(buildThinkingParams(provider("modelscope")), null);
  assert.equal(buildThinkingParams(provider("openai_chat")), null);
  assert.equal(buildThinkingParams(provider("anthropic"), "high"), null);
});

test("openrouter 档位序列化为 reasoning map（off = effort none，xhigh 直通）", () => {
  assert.deepEqual(buildThinkingParams(provider("openrouter"), "minimal"), {
    reasoning: { effort: "minimal" },
  });
  assert.deepEqual(buildThinkingParams(provider("openrouter"), "xhigh"), {
    reasoning: { effort: "xhigh" },
  });
  assert.deepEqual(buildThinkingParams(provider("openrouter"), "off"), {
    reasoning: { effort: "none" },
  });
});

test("modelscope 仅开关（toggle），on 开启 / off 关闭", () => {
  assert.deepEqual(buildThinkingParams(provider("modelscope"), "on"), { enable_thinking: true });
  assert.deepEqual(buildThinkingParams(provider("modelscope"), "off"), { enable_thinking: false });
  assert.equal(buildThinkingParams(provider("modelscope")), null);
});

test("openai_chat 顶层 reasoning_effort 直通档位（minimal/off），越界档位拒绝", () => {
  assert.deepEqual(buildThinkingParams(provider("openai_chat"), "minimal"), { reasoning_effort: "minimal" });
  assert.deepEqual(buildThinkingParams(provider("openai_chat"), "off"), { reasoning_effort: "none" });
  assert.equal(buildThinkingParams(provider("openai_chat")), null);
  assert.throws(() => buildThinkingParams(provider("openai_chat"), "xhigh"), /not supported/);
  assert.throws(() => buildThinkingParams(provider("openai_chat"), "max"), /not supported/);
});

test("超出厂商声明子集的档位拒绝，不静默下发", () => {
  assert.throws(() => buildThinkingParams(provider("deepseek"), "minimal"), /not supported/);
  assert.throws(() => buildThinkingParams(provider("deepseek"), "xhigh"), /not supported/);
  assert.throws(() => buildThinkingParams(provider("deepseek"), "on"), /not supported/);
  assert.throws(() => buildThinkingParams(provider("openrouter"), "max"), /not supported/);
  assert.throws(() => buildThinkingParams(provider("modelscope"), "medium"), /not supported/);
});

test("anthropic 不出 thinking 参数（budget 由 anthropic 适配器专用路径消费）", () => {
  assert.equal(buildThinkingParams(provider("anthropic"), "high"), null);
  assert.equal(effectiveThinkingBudget(provider("anthropic"), "high"), 32768);
  assert.throws(() => effectiveThinkingBudget(provider("anthropic"), "max"), /not supported/);
});

test("buildChatBody 合并厂商思考参数且不影响既有字段", () => {
  const body = buildChatBody(request(provider("deepseek"), "max"));
  assert.equal(body.model, "test-model");
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.thinking, { type: "enabled", reasoning_effort: "max" });
  assert.equal("reasoning_effort" in body, false);
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
