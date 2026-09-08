import assert from "node:assert/strict";
import test from "node:test";

import { LlmProviderClient } from "../dist/index.js";

test("OpenAI Compatible routes to the provider-declared endpoint; vendor adaptations layered on", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 5,
        total_tokens: 105,
        prompt_tokens_details: { cached_tokens: 90 },
      },
    }), { headers: { "content-type": "application/json" } });
  };

  // 厂商不再有专属类型：厂商差异 = 自定 endpoint + thinking_kind 声明（toggle 等）
  // + extraParams 静态参数（嵌套思考形状/缓存字段），全部在 provider 层表达。
  const cases = [
    {
      provider: {
        key: "alibaba", name: "alibaba", provider_type: "openai_chat", api_key: "secret",
        api_endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", thinking_kind: "toggle",
      },
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      thinkingLevel: "on",
      expectedThinking: { enable_thinking: true },
    },
    {
      provider: { key: "deepseek", name: "deepseek", provider_type: "openai_chat", api_key: "secret", api_endpoint: "https://api.deepseek.com/v1", thinking_kind: "effort" },
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      thinkingLevel: "high",
      expectedThinking: { reasoning_effort: "high" },
    },
  ];

  try {
    const client = new LlmProviderClient();
    for (const item of cases) {
      const result = await client.complete({
        provider: item.provider,
        model: "test-model",
        messages: [{ role: "user", content: "hello" }],
        thinkingLevel: item.thinkingLevel,
        tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
      });
      const call = calls.at(-1);
      assert.equal(call.url, item.endpoint);
      assert.equal(call.headers.get("authorization"), "Bearer secret");
      assert.deepEqual(call.body.messages, [{ role: "user", content: "hello" }]);
      assert.deepEqual(call.body.tools, [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }]);
      for (const [key, value] of Object.entries(item.expectedThinking)) assert.deepEqual(call.body[key], value);
      assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 90 });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
