import assert from "node:assert/strict";
import test from "node:test";

import { buildChatBody } from "../dist/providers/openai-chat.js";

const request = (providerType, providerExtra = {}) => ({
  provider: {
    key: "test",
    name: "test",
    provider_type: providerType,
    api_key: "k",
    ...providerExtra,
  },
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
  promptCacheKey: "stable-thread-key",
});

const build = (providerType, providerExtra = {}) => buildChatBody(request(providerType, providerExtra));

test("OpenAI Chat 下发稳定 prompt cache key", () => {
  const body = build("openai_chat");
  assert.equal(body.prompt_cache_key, "stable-thread-key");
  assert.equal(body.cache_control, undefined);
});

test("自定义 OpenAI Chat 端点仅在显式声明支持时下发缓存键", () => {
  const unsupported = build("openai_chat", { api_endpoint: "https://proxy.example/v1" });
  assert.equal(unsupported.prompt_cache_key, undefined);

  const supported = build("openai_chat", {
    api_endpoint: "https://proxy.example/v1",
    supports_prompt_caching: true,
  });
  assert.equal(supported.prompt_cache_key, "stable-thread-key");
});

test("通用兼容 provider 不下发未知缓存字段；厂商缓存参数经 extraParams 静态声明", () => {
  const body = build("openai_proxy");
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.cache_control, undefined);

  // openrouter 等厂商的 cache_control 等缓存参数由 provider extra_params 带入请求体（厂商层适配）
  const vendor = buildChatBody({
    ...request("openai_proxy"),
    extraParams: { cache_control: { type: "ephemeral" } },
  });
  assert.deepEqual(vendor.cache_control, { type: "ephemeral" });
});

test("openai 系 stream_options 统一携带 usage 选项", () => {
  assert.deepEqual(buildChatBody(request("openai_chat"), true).stream_options, { include_usage: true });
  assert.deepEqual(buildChatBody(request("openai_proxy"), true).stream_options, { include_usage: true });
});

test("关闭 prompt caching 后不下发缓存字段", () => {
  const body = build("openai_chat", { supports_prompt_caching: false });
  assert.equal(body.prompt_cache_key, undefined);
  assert.equal(body.cache_control, undefined);
});
