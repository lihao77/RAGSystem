import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiResponsesAdapter } from "../dist/providers/openai-responses.js";

const sseBody = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

test("OpenAI Responses 流式 reasoning summary delta 随 chunk 透传", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs-1" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "think " },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "twice" },
    { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg-1" } },
    { type: "response.output_text.delta", output_index: 1, delta: "answer" },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 9, output_tokens: 5, total_tokens: 14 } } },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const chunks = [];
    const adapter = new OpenAiResponsesAdapter();
    const result = await adapter.stream(
      {
        provider: { key: "test", name: "test", provider_type: "openai_resp", api_key: "k" },
        model: "gpt-test",
        messages: [{ role: "user", content: "hi" }],
      },
      async (chunk) => { chunks.push(chunk); },
    );
    assert.deepEqual(chunks.map((c) => ({ content: c.content, reasoning: c.reasoning })), [
      { content: "", reasoning: "think " },
      { content: "", reasoning: "twice" },
      { content: "answer", reasoning: undefined },
    ]);
    assert.equal(result.reasoning, "think twice");
    assert.equal(result.content, "answer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
