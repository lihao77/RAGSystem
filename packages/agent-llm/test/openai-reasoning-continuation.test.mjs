import assert from "node:assert/strict";
import test from "node:test";

import { LlmProviderClient } from "../dist/index.js";
import { buildChatBody } from "../dist/providers/openai-chat.js";

const sseBody = (chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");

test("OpenAI-compatible completion preserves reasoning wire fields for tool continuation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        reasoning_content: "think first",
        reasoning_details: [{ type: "reasoning.text", text: "think first" }],
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      finish_reason: "tool_calls",
    }],
  }), { headers: { "content-type": "application/json" } });

  try {
    const result = await new LlmProviderClient().complete({
      provider: { key: "qwen", name: "Qwen", provider_type: "qwen", api_key: "secret" },
      model: "qwen-plus",
      messages: [{ role: "user", content: "inspect" }],
    });
    assert.deepEqual(result.providerContinuation, {
      protocol: "openai_chat",
      toolCallIds: ["call-1"],
      assistantFields: {
        reasoning_content: "think first",
        reasoning_details: [{ type: "reasoning.text", text: "think first" }],
      },
    });

    const body = buildChatBody({
      provider: { key: "qwen", name: "Qwen", provider_type: "qwen", api_key: "secret" },
      model: "qwen-plus",
      messages: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          content: "",
          tool_calls: result.toolCalls,
          provider_continuation: result.providerContinuation,
        },
        { role: "tool", tool_call_id: "call-1", content: "{\"ok\":true}" },
      ],
    });
    assert.equal(body.messages[1].reasoning_content, "think first");
    assert.deepEqual(body.messages[1].reasoning_details, [{ type: "reasoning.text", text: "think first" }]);
    assert.deepEqual(body.messages[1].tool_calls, result.toolCalls);
    assert.equal("provider_continuation" in body.messages[1], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI-compatible stream accumulates reasoning deltas into continuation state", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { choices: [{ delta: { reasoning_content: "think ", reasoning_details: [{ index: 0, type: "reasoning.text", text: "think " }] } }] },
    { choices: [{ delta: { reasoning_content: "now", reasoning_details: [{ index: 0, text: "now" }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-2", function: { name: "read_file", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    { choices: [{ delta: {} }], finish_reason: "stop" },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const result = await new LlmProviderClient().stream({
      provider: { key: "qwen", name: "Qwen", provider_type: "qwen", api_key: "secret" },
      model: "qwen-plus",
      messages: [{ role: "user", content: "inspect" }],
    }, async () => {});
    assert.equal(result.reasoning, "think now");
    assert.deepEqual(result.providerContinuation, {
      protocol: "openai_chat",
      toolCallIds: ["call-2"],
      assistantFields: {
        reasoning_content: "think now",
        reasoning_details: [{ index: 0, type: "reasoning.text", text: "think now" }],
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
