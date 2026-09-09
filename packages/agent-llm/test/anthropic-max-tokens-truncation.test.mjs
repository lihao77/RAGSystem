import assert from "node:assert/strict";
import test from "node:test";

import { AnthropicAdapter } from "../dist/providers/anthropic.js";

/** SSE 事件序列 → Response body。 */
const sseBody = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`).join("");

const provider = () => ({
  key: "ds-anthropic",
  name: "ds-anthropic",
  provider_type: "anthropic",
  api_key: "k",
  api_endpoint: "https://api.deepseek.com/anthropic",
});

test("思考烧尽 max_tokens（无正文无工具）显式报错，不静默空回复", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { type: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
    { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "推理中途" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "被截断" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } } },
    { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4096 } } },
    { type: "message_stop", data: { type: "message_stop" } },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const chunks = [];
    const adapter = new AnthropicAdapter();
    await assert.rejects(
      adapter.stream(
        { provider: provider(), model: "deepseek-test", messages: [{ role: "user", content: "hi" }] },
        async (chunk) => { chunks.push(chunk); },
      ),
      (error) => {
        assert.match(error.message, /stopped at max_tokens/);
        assert.match(error.message, /thinking consumed the output budget/);
        return true;
      },
    );
    // 截断守卫抛错前，思考已作为 reasoning chunk 流出（思考块可见）。
    assert.deepEqual(chunks.map((c) => c.reasoning), ["推理中途", "被截断"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("max_tokens 但有半截正文时按既有语义放行（部分产出仍是有效轮）", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { type: "message_start", data: { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } } },
    { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "半截回答" } } },
    { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } } },
    { type: "message_stop", data: { type: "message_stop" } },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const adapter = new AnthropicAdapter();
    const result = await adapter.stream(
      { provider: provider(), model: "deepseek-test", messages: [{ role: "user", content: "hi" }] },
      async () => {},
    );
    assert.equal(result.content, "半截回答");
    assert.equal(result.finishReason, "max_tokens");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("非流式 stop_reason=max_tokens 且仅 thinking 块同样报错", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    stop_reason: "max_tokens",
    content: [{ type: "thinking", thinking: "想了很多", signature: "sig-1" }],
  }), { headers: { "content-type": "application/json" } });

  try {
    const adapter = new AnthropicAdapter();
    await assert.rejects(
      adapter.complete({ provider: provider(), model: "deepseek-test", messages: [{ role: "user", content: "hi" }] }),
      /stopped at max_tokens.*no assistant text or tool calls/s,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
