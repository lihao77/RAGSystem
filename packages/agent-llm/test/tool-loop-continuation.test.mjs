import assert from "node:assert/strict";
import test from "node:test";

import { buildAnthropicBody } from "../dist/providers/anthropic.js";
import { buildChatBody } from "../dist/providers/openai-chat.js";
import { buildResponsesBody, OpenAiResponsesAdapter } from "../dist/providers/openai-responses.js";

const thinking = (text, signature) => ({ type: "thinking", thinking: text, signature });
const toolCall = (id) => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } });

/** 两轮工具循环的标准事务：user → A1(tool₁) → T1 → A2(tool₂) → T2。 */
const multiRoundMessages = (round1, round2) => [
  { role: "user", content: "check both files" },
  { role: "assistant", content: "", tool_calls: [toolCall("call-1")], ...round1 },
  { role: "tool", tool_call_id: "call-1", content: "first result" },
  { role: "assistant", content: "", tool_calls: [toolCall("call-2")], ...round2 },
  { role: "tool", tool_call_id: "call-2", content: "second result" },
];

test("Anthropic 工具循环内每条 assistant 的 thinking 块都随自己的 tool_use 回传", () => {
  const body = buildAnthropicBody({
    provider: { key: "test", name: "test", provider_type: "anthropic", api_key: "k" },
    model: "test-model",
    messages: multiRoundMessages(
      { reasoning_blocks: [thinking("round one", "sig-1"), { type: "redacted_thinking", data: "redacted-1" }] },
      { reasoning_blocks: [thinking("round two", "sig-2")] },
    ),
  });

  assert.deepEqual(body.messages[1].content.map((block) => block.type), ["thinking", "redacted_thinking", "tool_use"]);
  assert.equal(body.messages[1].content[0].signature, "sig-1");
  assert.deepEqual(body.messages[3].content.map((block) => block.type), ["thinking", "tool_use"]);
  assert.equal(body.messages[3].content[0].signature, "sig-2");
});

test("Anthropic 恢复的 provider_continuation 同样注入对应 assistant 消息", () => {
  const body = buildAnthropicBody({
    provider: { key: "test", name: "test", provider_type: "anthropic", api_key: "k" },
    model: "test-model",
    messages: multiRoundMessages(
      { provider_continuation: { protocol: "anthropic_messages", toolCallIds: ["call-1"], blocks: [thinking("restored one", "sig-r1")] } },
      { reasoning_blocks: [thinking("round two", "sig-2")] },
    ),
  });

  assert.deepEqual(body.messages[1].content.map((block) => block.type), ["thinking", "tool_use"]);
  assert.equal(body.messages[1].content[0].thinking, "restored one");
  assert.deepEqual(body.messages[3].content.map((block) => block.type), ["thinking", "tool_use"]);
});

test("Anthropic 事务外的历史 assistant 消息不注入任何 thinking", () => {
  const body = buildAnthropicBody({
    provider: { key: "test", name: "test", provider_type: "anthropic", api_key: "k" },
    model: "test-model",
    messages: [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new question" },
      { role: "assistant", content: "", tool_calls: [toolCall("call-1")], reasoning_blocks: [thinking("current", "sig")] },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ],
  });

  assert.deepEqual(body.messages[1].content, [{ type: "text", text: "old answer" }]);
  assert.deepEqual(body.messages[3].content.map((block) => block.type), ["thinking", "tool_use"]);
});

test("Anthropic 缺签名的 thinking 块降级为 text 块而非丢弃", () => {
  const body = buildAnthropicBody({
    provider: { key: "test", name: "test", provider_type: "anthropic", api_key: "k" },
    model: "test-model",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [toolCall("call-1")],
        reasoning_blocks: [{ type: "thinking", thinking: "unsigned thought", signature: "" }],
      },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ],
  });

  assert.deepEqual(body.messages[1].content.map((block) => block.type), ["text", "tool_use"]);
  assert.equal(body.messages[1].content[0].text, "unsigned thought");
});

test("DeepSeek thinking + tools：缺 reasoning_content 的 assistant 轮补空串", () => {
  const body = buildChatBody({
    provider: { key: "ds", name: "DeepSeek", provider_type: "deepseek", api_key: "k" },
    model: "deepseek-v4-pro",
    thinkingLevel: "low",
    messages: multiRoundMessages(
      { provider_continuation: { protocol: "openai_chat", toolCallIds: ["call-1"], assistantFields: { reasoning_content: "think one" } } },
      {},
    ),
  });

  const assistants = body.messages.filter((message) => message.role === "assistant" && message.tool_calls);
  assert.equal(assistants[0].reasoning_content, "think one");
  assert.equal(assistants[1].reasoning_content, "");
});

test("DeepSeek 特判走能力位：未标记的兼容厂商不补 reasoning_content", async () => {
  const { providerTypeSpec } = await import("../dist/provider-registry.js");
  assert.equal(providerTypeSpec("deepseek").requiresReasoningContentOnAssistantMessages, true);
  assert.notEqual(providerTypeSpec("qwen").requiresReasoningContentOnAssistantMessages, true);

  const body = buildChatBody({
    provider: { key: "qwen", name: "Qwen", provider_type: "qwen", api_key: "k" },
    model: "qwen-plus",
    thinkingLevel: "on",
    messages: multiRoundMessages({}, {}),
  });

  const assistants = body.messages.filter((message) => message.role === "assistant" && message.tool_calls);
  assert.equal(assistants[0].reasoning_content, undefined);
  assert.equal(assistants[1].reasoning_content, undefined);
});

test("OpenAI Responses 开启思考时请求 encrypted reasoning 内容", () => {
  const body = buildResponsesBody({
    provider: { key: "test", name: "test", provider_type: "openai_resp", api_key: "k" },
    model: "gpt-test",
    thinkingLevel: "low",
    messages: [{ role: "user", content: "hi" }],
  });

  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(body.reasoning, { effort: "low" });
});

const responsesContinuation = (callId, items) => ({
  protocol: "openai_responses",
  toolCallIds: [callId],
  anchorCallId: callId,
  reasoningItems: items,
});

test("OpenAI Responses 每轮 reasoning items 紧挨自己轮次的 function_call 注入", () => {
  const body = buildResponsesBody({
    provider: { key: "test", name: "test", provider_type: "openai_resp", api_key: "k" },
    model: "gpt-test",
    messages: multiRoundMessages(
      { provider_continuation: responsesContinuation("call-1", [{ type: "reasoning", id: "rs-1" }]) },
      { provider_continuation: responsesContinuation("call-2", [{ type: "reasoning", id: "rs-2" }]) },
    ),
  });

  assert.deepEqual(body.input.map((item) => item.type), [
    "message",
    "reasoning",
    "function_call",
    "function_call_output",
    "reasoning",
    "function_call",
    "function_call_output",
  ]);
  assert.equal(body.input[1].id, "rs-1");
  assert.equal(body.input[4].id, "rs-2");
  assert.equal(body.input[2].call_id, "call-1");
  assert.equal(body.input[5].call_id, "call-2");
});

test("OpenAI Responses continuation 只携带本轮 items，不再与历史轮次合并", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "completed",
    output: [
      { type: "reasoning", id: "rs-2" },
      { type: "function_call", call_id: "call-2", name: "read_file", arguments: "{}" },
    ],
  }), { headers: { "content-type": "application/json" } });

  try {
    const result = await new OpenAiResponsesAdapter().complete({
      provider: { key: "test", name: "test", provider_type: "openai_resp", api_key: "k" },
      model: "gpt-test",
      messages: multiRoundMessages(
        { provider_continuation: responsesContinuation("call-1", [{ type: "reasoning", id: "rs-1" }]) },
        {},
      ),
    });

    assert.deepEqual(result.providerContinuation, responsesContinuation("call-2", [{ type: "reasoning", id: "rs-2" }]));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI chat 兼容通道循环内每条 assistant 各自回显 reasoning 字段", () => {
  const chatContinuation = (callId, text) => ({
    protocol: "openai_chat",
    toolCallIds: [callId],
    assistantFields: { reasoning_content: text },
  });
  const body = buildChatBody({
    provider: { key: "test", name: "test", provider_type: "openai_chat", api_key: "k" },
    model: "test-model",
    messages: multiRoundMessages(
      { provider_continuation: chatContinuation("call-1", "think one") },
      { provider_continuation: chatContinuation("call-2", "think two") },
    ),
  });

  const assistants = body.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 2);
  assert.equal(assistants[0].reasoning_content, "think one");
  assert.equal(assistants[1].reasoning_content, "think two");
  assert.equal("provider_continuation" in assistants[0], false);
  assert.equal("provider_continuation" in assistants[1], false);
});
