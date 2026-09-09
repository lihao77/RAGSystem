import assert from "node:assert/strict";
import test from "node:test";

import { OpenAiResponsesAdapter } from "../dist/providers/openai-responses.js";

const sseBody = (events) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

const deepseekProvider = () => ({
  key: "ds",
  name: "ds",
  provider_type: "openai_resp",
  api_key: "k",
  api_endpoint: "https://api.deepseek.com",
  thinking_kind: "effort",
});

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
        provider: { key: "test", name: "test", provider_type: "openai_resp", api_key: "k", thinking_kind: "effort" },
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

test("DeepSeek 形态流式 reasoning_text delta 透传，正文不被推理文本污染", async () => {
  const reasoningItem = {
    type: "reasoning",
    id: "rs-1",
    status: "completed",
    content: [{ type: "reasoning_text", text: "推理正文" }],
    summary: [],
    encrypted_content: "enc-1",
  };
  const messageItem = {
    type: "message",
    id: "msg-1",
    status: "completed",
    content: [{ type: "output_text", text: "answer" }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs-1" } },
    { type: "response.reasoning_text.delta", output_index: 0, delta: "推理" },
    { type: "response.reasoning_text.delta", output_index: 0, delta: "正文" },
    { type: "response.output_text.delta", output_index: 1, delta: "answer" },
    { type: "response.completed", response: { status: "completed", output: [reasoningItem, messageItem] } },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const chunks = [];
    const adapter = new OpenAiResponsesAdapter();
    const result = await adapter.stream(
      { provider: deepseekProvider(), model: "deepseek-test", messages: [{ role: "user", content: "hi" }] },
      async (chunk) => { chunks.push(chunk); },
    );
    assert.deepEqual(chunks.map((c) => ({ content: c.content, reasoning: c.reasoning })), [
      { content: "", reasoning: "推理" },
      { content: "", reasoning: "正文" },
      { content: "answer", reasoning: undefined },
    ]);
    assert.equal(result.reasoning, "推理正文");
    assert.equal(result.content, "answer");
    assert.equal(result.finishReason, "completed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DeepSeek 形态推理烧尽输出预算（incomplete 无正文无工具）显式报错，不静默空回复", async () => {
  const reasoningItem = {
    type: "reasoning",
    id: "rs-1",
    status: "incomplete",
    content: [{ type: "reasoning_text", text: "推理中途被截断" }],
    summary: [],
    encrypted_content: "enc-1",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs-1" } },
    { type: "response.reasoning_text.delta", output_index: 0, delta: "推理中途" },
    { type: "response.reasoning_text.delta", output_index: 0, delta: "被截断" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [reasoningItem] } },
  ]), { headers: { "content-type": "text/event-stream" } });

  try {
    const chunks = [];
    const adapter = new OpenAiResponsesAdapter();
    await assert.rejects(
      adapter.stream(
        { provider: deepseekProvider(), model: "deepseek-test", messages: [{ role: "user", content: "hi" }] },
        async (chunk) => { chunks.push(chunk); },
      ),
      (error) => {
        assert.match(error.message, /incomplete \(max_output_tokens\)/);
        assert.match(error.message, /max_output_tokens/);
        return true;
      },
    );
    // 截断守卫抛错前，思考文本已经作为 reasoning chunk 流出（前端思考块可见）。
    assert.deepEqual(chunks.map((c) => c.reasoning), ["推理中途", "被截断"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incomplete 但有半截正文/半截工具 JSON 时按既有语义放行（部分产出仍是有效轮）", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(sseBody([
    { type: "response.output_text.delta", output_index: 0, delta: "半截回答" },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "message", id: "m-1", content: [{ type: "output_text", text: "半截回答" }] }] } },
  ]), { headers: { "content-type": "text/event-stream" } });
  try {
    const adapter = new OpenAiResponsesAdapter();
    const result = await adapter.stream(
      { provider: deepseekProvider(), model: "deepseek-test", messages: [{ role: "user", content: "hi" }] },
      async () => {},
    );
    assert.equal(result.content, "半截回答");
    assert.equal(result.finishReason, "incomplete");
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => new Response(sseBody([
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "write_file", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path": "aa' },
    { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "function_call", id: "fc-1", call_id: "call-1", name: "write_file", arguments: '{"path": "aa' }] } },
  ]), { headers: { "content-type": "text/event-stream" } });
  try {
    const adapter = new OpenAiResponsesAdapter();
    const result = await adapter.stream(
      { provider: deepseekProvider(), model: "deepseek-test", messages: [{ role: "user", content: "hi" }] },
      async () => {},
    );
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].function.name, "write_file");
    assert.equal(result.toolCalls[0].function.arguments, '{"path": "aa');
    assert.equal(result.finishReason, "incomplete");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("非流式 incomplete 无正文无工具同样报错；completed 时推理/正文按 item 分流", async () => {
  const adapter = new OpenAiResponsesAdapter();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "reasoning", id: "rs-1", status: "incomplete", content: [{ type: "reasoning_text", text: "想了很多" }], summary: [] }],
  }), { headers: { "content-type": "application/json" } });
  try {
    await assert.rejects(
      adapter.complete({ provider: deepseekProvider(), model: "deepseek-test", messages: [{ role: "user", content: "hi" }] }),
      /incomplete \(max_output_tokens\).*no assistant output/s,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "completed",
    output: [
      { type: "reasoning", id: "rs-1", status: "completed", content: [{ type: "reasoning_text", text: "想了一下" }], summary: [] },
      { type: "message", id: "msg-1", status: "completed", content: [{ type: "output_text", text: "答复" }] },
    ],
  }), { headers: { "content-type": "application/json" } });
  try {
    const result = await adapter.complete({ provider: deepseekProvider(), model: "deepseek-test", messages: [{ role: "user", content: "hi" }] });
    assert.equal(result.content, "答复");
    assert.equal(result.reasoning, "想了一下");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
