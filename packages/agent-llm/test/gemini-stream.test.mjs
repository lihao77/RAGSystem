import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiCompatibleClient } from "../dist/index.js";

const sseBody = (chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");

test("Gemini complete routes through generateContent and returns continuation state", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody;
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{
        content: {
          role: "model",
          parts: [
            { text: "reason", thought: true },
            { text: "checking" },
            {
              functionCall: { id: "call-3", name: "read_file", args: { path: "README.md" } },
              thoughtSignature: "signature-3",
            },
          ],
        },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 50, totalTokenCount: 60, cachedContentTokenCount: 48 },
    }), { headers: { "content-type": "application/json" } });
  };

  try {
    const result = await new OpenAiCompatibleClient().complete({
      provider: { key: "gemini", name: "Gemini", provider_type: "gemini", api_key: "not-logged" },
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "inspect" }],
    });

    assert.equal(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    assert.deepEqual(capturedBody.contents, [{ role: "user", parts: [{ text: "inspect" }] }]);
    assert.equal(result.content, "checking");
    assert.equal(result.reasoning, "reason");
    assert.deepEqual(result.providerContinuation, {
      protocol: "gemini_generate_content",
      toolCallIds: ["call-3"],
      parts: [
        { text: "reason", thought: true },
        { text: "checking" },
        {
          functionCall: { id: "call-3", name: "read_file", args: { path: "README.md" } },
          thoughtSignature: "signature-3",
        },
      ],
    });
    assert.deepEqual(result.usage, {
      inputTokens: 50,
      outputTokens: 10,
      totalTokens: 60,
      cachedInputTokens: 48,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini stream separates thoughts, preserves signatures, tools, and cache usage", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders;
  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = new Headers(init.headers);
    return new Response(sseBody([
      {
        candidates: [{ content: { role: "model", parts: [{ text: "plan", thought: true }] } }],
      },
      {
        candidates: [{ content: { role: "model", parts: [{ text: "done" }] } }],
      },
      {
        candidates: [{
          content: {
            role: "model",
            parts: [{
              functionCall: { id: "call-7", name: "read_file", args: { path: "README.md" } },
              thoughtSignature: "signature-7",
            }],
          },
          finishReason: "STOP",
        }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 8,
          thoughtsTokenCount: 4,
          totalTokenCount: 112,
          cachedContentTokenCount: 97,
        },
      },
    ]), { headers: { "content-type": "text/event-stream" } });
  };

  try {
    const chunks = [];
    const result = await new OpenAiCompatibleClient().stream({
      provider: { key: "gemini", name: "Gemini", provider_type: "gemini", api_key: "not-logged" },
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "inspect" }],
      tools: [{
        type: "function",
        function: { name: "read_file", parameters: { type: "object" } },
      }],
    }, async (chunk) => { chunks.push(chunk); });

    assert.equal(capturedUrl, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse");
    assert.equal(capturedHeaders.get("x-goog-api-key"), "not-logged");
    assert.equal(capturedHeaders.get("authorization"), null);
    assert.equal(result.content, "done");
    assert.equal(result.reasoning, "plan");
    assert.equal(result.finishReason, "STOP");
    assert.deepEqual(result.toolCalls, [{
      id: "call-7",
      type: "function",
      function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
    }]);
    assert.deepEqual(result.providerContinuation, {
      protocol: "gemini_generate_content",
      toolCallIds: ["call-7"],
      parts: [
        { text: "plan", thought: true },
        { text: "done" },
        {
          functionCall: { id: "call-7", name: "read_file", args: { path: "README.md" } },
          thoughtSignature: "signature-7",
        },
      ],
    });
    assert.deepEqual(result.usage, {
      inputTokens: 100,
      outputTokens: 12,
      totalTokens: 112,
      cachedInputTokens: 97,
    });
    assert.deepEqual(chunks.map((chunk) => ({ content: chunk.content, toolCalls: chunk.toolCalls })), [
      { content: "done", toolCalls: undefined },
      { content: "", toolCalls: result.toolCalls },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Gemini stream preserves tool order across chunks and merges partial usage metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    {
      candidates: [{
        content: {
          role: "model",
          parts: [
            { functionCall: { name: "first", args: { value: 1 } } },
            { text: "between" },
          ],
        },
      }],
      usageMetadata: {
        promptTokenCount: 100,
        totalTokenCount: 110,
        cachedContentTokenCount: 80,
      },
    },
    {
      candidates: [{
        content: {
          role: "model",
          parts: [{ functionCall: { name: "second", args: { value: 2 } } }],
        },
        finishReason: "STOP",
      }],
      usageMetadata: { candidatesTokenCount: 1 },
    },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const result = await new OpenAiCompatibleClient().stream({
      provider: { key: "gemini", name: "Gemini", provider_type: "gemini", api_key: "not-logged" },
      model: "gemini-2.5-flash",
      messages: [{ role: "user", content: "inspect" }],
      tools: [
        { type: "function", function: { name: "first", parameters: { type: "object" } } },
        { type: "function", function: { name: "second", parameters: { type: "object" } } },
      ],
    }, async () => {});

    assert.equal(result.content, "between");
    assert.deepEqual(result.toolCalls, [
      { id: "gemini_call_0", type: "function", function: { name: "first", arguments: "{\"value\":1}" } },
      { id: "gemini_call_1", type: "function", function: { name: "second", arguments: "{\"value\":2}" } },
    ]);
    assert.deepEqual(result.providerContinuation, {
      protocol: "gemini_generate_content",
      toolCallIds: ["gemini_call_0", "gemini_call_1"],
      parts: [
        { functionCall: { name: "first", args: { value: 1 } } },
        { text: "between" },
        { functionCall: { name: "second", args: { value: 2 } } },
      ],
    });
    assert.deepEqual(result.usage, {
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedInputTokens: 80,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
