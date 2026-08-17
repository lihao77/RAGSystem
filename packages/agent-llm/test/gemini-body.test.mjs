import assert from "node:assert/strict";
import test from "node:test";

import { buildGeminiBody, resolveGeminiEndpoint } from "../dist/providers/gemini.js";

const continuationParts = [
  { text: "checking", thought: true },
  {
    functionCall: { id: "call-1", name: "read_file", args: { path: "README.md" } },
    thoughtSignature: "opaque-signature",
  },
];

test("Gemini body maps system, images, tools, function responses, and continuation parts", () => {
  const request = {
    provider: {
      key: "gemini",
      name: "Gemini",
      provider_type: "gemini",
      api_key: "secret",
      max_tokens: 2048,
    },
    model: "gemini-2.5-flash",
    temperature: 0.2,
    extraParams: { generationConfig: { topP: 0.9 } },
    messages: [
      { role: "system", content: "stable system" },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }],
        provider_continuation: {
          protocol: "gemini_generate_content",
          toolCallIds: ["call-1"],
          parts: continuationParts,
        },
      },
      { role: "tool", tool_call_id: "call-1", content: "{\"text\":\"contents\"}" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      source: "runtime_builtin",
    }],
    toolChoice: "auto",
  };

  const body = buildGeminiBody(request);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "stable system" }] });
  assert.deepEqual(body.generationConfig, { topP: 0.9, temperature: 0.2, maxOutputTokens: 2048 });
  assert.deepEqual(body.contents, [
    {
      role: "user",
      parts: [
        { text: "inspect" },
        { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
      ],
    },
    { role: "model", parts: continuationParts },
    {
      role: "user",
      parts: [{
        functionResponse: {
          id: "call-1",
          name: "read_file",
          response: { text: "contents" },
        },
      }],
    },
  ]);
  assert.deepEqual(body.tools, [{
    functionDeclarations: [{
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    }],
  }]);
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
});

test("Gemini omits a fabricated function response id when the provider omitted one", () => {
  const body = buildGeminiBody({
    provider: { key: "gemini", name: "Gemini", provider_type: "gemini", api_key: "secret" },
    model: "gemini-2.5-flash",
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "gemini_call_0", type: "function", function: { name: "read_file", arguments: "{}" } }],
        provider_continuation: {
          protocol: "gemini_generate_content",
          toolCallIds: ["gemini_call_0"],
          parts: [{ functionCall: { name: "read_file", args: {} } }],
        },
      },
      { role: "tool", tool_call_id: "gemini_call_0", content: "{\"ok\":true}" },
    ],
  });

  assert.deepEqual(body.contents[1], {
    role: "user",
    parts: [{ functionResponse: { name: "read_file", response: { ok: true } } }],
  });
});

test("Gemini endpoints select generateContent and SSE stream methods", () => {
  const request = {
    provider: { key: "gemini", name: "Gemini", provider_type: "gemini", api_key: "secret" },
    model: "models/gemini-2.5-flash",
    messages: [{ role: "user", content: "hello" }],
  };
  assert.equal(
    resolveGeminiEndpoint(request, false),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  );
  assert.equal(
    resolveGeminiEndpoint(request, true),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
  );
});
