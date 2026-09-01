import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../dist/providers/anthropic.js";

/** SSE 事件序列 → Response body（message_start/message_delta 的 usage 随事件流）。 */
const sseBody = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`).join("");

test("Anthropic 流式响应保留缓存命中 token（cache_read / cache_creation）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    {
      type: "message_start",
      data: {
        type: "message_start",
        message: {
          usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 100, output_tokens: 0 },
        },
      },
    },
    { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } } },
    { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } } },
    { type: "message_stop", data: { type: "message_stop" } },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const adapter = new AnthropicAdapter();
    const result = await adapter.stream(
      {
        provider: { key: "test", name: "test", provider_type: "anthropic", api_key: "k" },
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
      },
      async () => {},
    );
    // input = 20 + 30(cache_creation) + 100(cache_read)；output 来自 message_delta。
    assert.deepEqual(result.usage, {
      inputTokens: 150,
      outputTokens: 9,
      totalTokens: 159,
      cachedInputTokens: 100,
      cacheCreationInputTokens: 30,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic 流式 thinking_delta 随 chunk 透传 reasoning", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { type: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
    { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "ponder " } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "deeply" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } } },
    { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { type: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "answer" } } },
    { type: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } } },
    { type: "message_stop", data: { type: "message_stop" } },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const chunks = [];
    const adapter = new AnthropicAdapter();
    const result = await adapter.stream(
      {
        provider: { key: "test", name: "test", provider_type: "anthropic", api_key: "k" },
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
      },
      async (chunk) => { chunks.push(chunk); },
    );
    assert.deepEqual(chunks.map((c) => ({ content: c.content, reasoning: c.reasoning })), [
      { content: "", reasoning: "ponder " },
      { content: "", reasoning: "deeply" },
      { content: "answer", reasoning: undefined },
    ]);
    assert.equal(result.reasoning, "ponder deeply");
    assert.equal(result.content, "answer");
    assert.deepEqual(result.reasoningBlocks, [{ type: "thinking", thinking: "ponder deeply", signature: "sig-1" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic 流式无缓存事件时不伪造缓存字段", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { type: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
    { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
    { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } } },
    { type: "message_stop", data: { type: "message_stop" } },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const adapter = new AnthropicAdapter();
    const result = await adapter.stream(
      {
        provider: { key: "test", name: "test", provider_type: "anthropic", api_key: "k" },
        model: "claude-test",
        messages: [{ role: "user", content: "hi" }],
      },
      async () => {},
    );
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Anthropic 流在 content_block_stop 前结束时仍携带已累积的工具调用", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { type: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } } },
    {
      type: "content_block_start",
      data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "search", input: {} } },
    },
    {
      type: "content_block_delta",
      data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"x' } },
    },
    // 对端提前收流：没有 content_block_stop，直接 message_delta + message_stop
    { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } } },
    { type: "message_stop", data: { type: "message_stop" } },
  ]), { headers: { "content-type": "text/event-stream" } });
  try {
    const result = await new AnthropicAdapter().stream(
      {
        provider: { key: "a", name: "A", provider_type: "anthropic", api_key: "secret", api_endpoint: "https://api.anthropic.com" },
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      },
      async () => undefined,
    );
    assert.deepEqual(result.toolCalls, [
      { id: "toolu_1", type: "function", function: { name: "search", arguments: '{"q":"x' } },
    ]);
    assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("zhipu 网关形状：message_start 全 0、真实 input/cache 只随 message_delta 到达", async () => {
  // 形状取自 wire 抓取实测（llm-wire-report --usage-shapes）：
  // message_start.usage 全 0；message_delta.usage 带 input_tokens + cache_read_input_tokens
  // + 非数值附加字段（server_tool_use/service_tier）。input 侧必须从 delta 采纳，
  // 否则 run 级 token_in=0、该轮缓存进分子不进分母（会话命中率 >100%）。
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { type: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } } },
    { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
    { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      type: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: {
          input_tokens: 1303,
          output_tokens: 142,
          cache_read_input_tokens: 9472,
          server_tool_use: { web_search_requests: 0 },
          service_tier: "standard",
        },
      },
    },
    { type: "message_stop", data: { type: "message_stop" } },
  ]), { headers: { "content-type": "text/event-stream" } });
  try {
    const result = await new AnthropicAdapter().stream(
      {
        provider: { key: "pqy", name: "P", provider_type: "anthropic", api_key: "secret", api_endpoint: "https://gw.example" },
        model: "glm-5.3-flash",
        messages: [{ role: "user", content: "hi" }],
      },
      async () => undefined,
    );
    // input = 1303(uncached) + 9472(cache_read)；cached 单列。
    assert.deepEqual(result.usage, {
      inputTokens: 10775,
      outputTokens: 142,
      totalTokens: 10917,
      cachedInputTokens: 9472,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
