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
