import assert from "node:assert/strict";
import test from "node:test";

import { buildChatBody } from "../dist/providers/openai-chat.js";

const build = (providerType, providerExtra = {}) => buildChatBody({
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

test("OpenRouter 下发稳定 key 并启用自动尾部缓存", () => {
  const body = build("openrouter");
  assert.equal(body.prompt_cache_key, "stable-thread-key");
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
});

test("DeepSeek 和通用兼容 provider 不接收未知缓存字段", () => {
  for (const providerType of ["deepseek", "modelscope", "openai_proxy"]) {
    const body = build(providerType);
    assert.equal(body.prompt_cache_key, undefined);
    assert.equal(body.cache_control, undefined);
  }
});

test("关闭 prompt caching 后 OpenAI Chat 和 OpenRouter 均不下发缓存字段", () => {
  for (const providerType of ["openai_chat", "openrouter"]) {
    const body = build(providerType, { supports_prompt_caching: false });
    assert.equal(body.prompt_cache_key, undefined);
    assert.equal(body.cache_control, undefined);
  }
});
