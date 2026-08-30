import assert from "node:assert/strict";
import test from "node:test";

import { buildAnthropicBody, AnthropicAdapter } from "../dist/providers/anthropic.js";
import { buildChatBody, OpenAiChatAdapter } from "../dist/providers/openai-chat.js";
import { buildResponsesBody, OpenAiResponsesAdapter } from "../dist/providers/openai-responses.js";
import { parseProviderContinuationState } from "../dist/provider-continuation.js";

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

test("Anthropic 无思考数据的 assistant 消息不注入任何块", () => {
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

test("Anthropic 跨 run：provider_continuation 注入事务外的纯文字轮（pi 全历史语义）", () => {
  const body = buildAnthropicBody({
    provider: { key: "test", name: "test", provider_type: "anthropic", api_key: "k" },
    model: "test-model",
    messages: [
      { role: "user", content: "old question" },
      {
        role: "assistant",
        content: "old answer",
        provider_continuation: {
          protocol: "anthropic_messages",
          toolCallIds: [],
          blocks: [thinking("final round reasoning", "sig-final")],
        },
      },
      { role: "user", content: "new question" },
    ],
  });

  assert.deepEqual(body.messages[1].content.map((block) => block.type), ["thinking", "text"]);
  assert.equal(body.messages[1].content[0].signature, "sig-final");
  assert.equal(body.messages[1].content[1].text, "old answer");
});

test("Anthropic 缺签名的 thinking 块降级为 <think> 包裹的 text 块而非丢弃", () => {
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
  assert.equal(body.messages[1].content[0].text, "<think>unsigned thought</think>");
});

test("思考模式 + tools：缺 reasoning_content 的 assistant 轮（含纯文字轮）补空串", () => {
  const body = buildChatBody({
    provider: { key: "ds", name: "DeepSeek", provider_type: "openai_chat", api_key: "k" },
    model: "deepseek-v4-pro",
    thinkingLevel: "low",
    messages: [
      { role: "user", content: "check the file" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "check both files" },
      { role: "assistant", content: "", tool_calls: [toolCall("call-1")], provider_continuation: { protocol: "openai_chat", toolCallIds: ["call-1"], assistantFields: { reasoning_content: "think one" } } },
      { role: "tool", tool_call_id: "call-1", content: "first result" },
      { role: "assistant", content: "", tool_calls: [toolCall("call-2")] },
      { role: "tool", tool_call_id: "call-2", content: "second result" },
    ],
  });

  const assistants = body.messages.filter((message) => message.role === "assistant");
  assert.equal(assistants.length, 3);
  assert.equal(assistants[0].reasoning_content, "");
  assert.equal(assistants[1].reasoning_content, "think one");
  assert.equal(assistants[2].reasoning_content, "");
});

test("reasoning_field 声明（目录 interleaved.field）：补齐字段跟随方言，已带思考字段的轮不重复补", () => {
  const body = buildChatBody({
    // openrouter 部分模型为 reasoning_details 方言（目录模型级声明，投影进 provider）
    provider: { key: "or", name: "OpenRouter", provider_type: "openai_chat", api_key: "k", reasoning_field: "reasoning_details" },
    model: "grok-4",
    thinkingLevel: "high",
    messages: [
      { role: "user", content: "check the file" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "again" },
      { role: "assistant", content: "", tool_calls: [toolCall("call-1")], provider_continuation: { protocol: "openai_chat", toolCallIds: ["call-1"], assistantFields: { reasoning_details: [{ type: "summary", text: "think one" }] } } },
      { role: "tool", tool_call_id: "call-1", content: "result" },
      { role: "assistant", content: "", tool_calls: [toolCall("call-2")] },
      { role: "tool", tool_call_id: "call-2", content: "more" },
    ],
  });

  const assistants = body.messages.filter((message) => message.role === "assistant");
  // 纯文字轮与无字段的 tool 轮按声明补 reasoning_details（不补 reasoning_content）
  assert.equal(assistants[0].reasoning_details, "");
  assert.equal(assistants[0].reasoning_content, undefined);
  // continuation 带回的厂商原始字段原样保留，不重复补
  assert.deepEqual(assistants[1].reasoning_details, [{ type: "summary", text: "think one" }]);
  assert.equal(assistants[2].reasoning_details, "");
  assert.equal(assistants[2].reasoning_content, undefined);
});

test("思考补齐：轮内已有任一思考线字段（如 reasoning 字符串方言）则不注入", () => {
  const body = buildChatBody({
    provider: { key: "gw", name: "Gateway", provider_type: "openai_chat", api_key: "k" },
    model: "some-model",
    thinkingLevel: "low",
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: "", tool_calls: [toolCall("call-1")], provider_continuation: { protocol: "openai_chat", toolCallIds: ["call-1"], assistantFields: { reasoning: "alternate dialect" } } },
      { role: "tool", tool_call_id: "call-1", content: "result" },
    ],
  });

  const assistant = body.messages.find((message) => message.role === "assistant");
  assert.equal(assistant.reasoning, "alternate dialect");
  assert.equal(assistant.reasoning_content, undefined);
});

test("思考补齐激活绑定形状实际生效：kind=none / budget 覆盖 + 陈旧档位不注入任何字段", () => {
  const messages = [
    { role: "user", content: "go" },
    { role: "assistant", content: "old answer" },
  ];
  // thinking_kind 声明 none（无思考通道）：tier 残留档位不得触发补齐
  const noneKind = buildChatBody({
    provider: { key: "t", name: "T", provider_type: "openai_chat", api_key: "k", thinking_kind: "none" },
    model: "m",
    thinkingLevel: "high",
    messages,
  });
  assert.equal(noneKind.messages[1].reasoning_content, undefined);
  assert.equal(noneKind.messages[1].reasoning_details, undefined);
  // budget 覆盖到 openai 系：请求体无思考参数（budget 由 anthropic 适配器消费），同样不补
  const budgetKind = buildChatBody({
    provider: { key: "t", name: "T", provider_type: "openai_chat", api_key: "k", thinking_kind: "budget" },
    model: "m",
    thinkingLevel: "high",
    messages,
  });
  assert.equal(budgetKind.messages[1].reasoning_content, undefined);
  assert.equal(budgetKind.reasoning_effort, undefined);
});

test("思考模式补齐与厂商无关：兼容厂商同样补空串，未开思考不注入", () => {
  const body = buildChatBody({
    provider: { key: "qwen", name: "Qwen", provider_type: "openai_chat", thinking_kind: "toggle", api_key: "k" },
    model: "qwen-plus",
    thinkingLevel: "on",
    messages: multiRoundMessages({}, {}),
  });

  const assistants = body.messages.filter((message) => message.role === "assistant" && message.tool_calls);
  assert.equal(assistants[0].reasoning_content, "");
  assert.equal(assistants[1].reasoning_content, "");

  // 未开启思考时不注入，避免给严格网关发送未知消息字段
  const plain = buildChatBody({
    provider: { key: "qwen", name: "Qwen", provider_type: "openai_chat", thinking_kind: "toggle", api_key: "k" },
    model: "qwen-plus",
    messages: multiRoundMessages({}, {}),
  });
  const plainAssistants = plain.messages.filter((message) => message.role === "assistant" && message.tool_calls);
  assert.equal(plainAssistants[0].reasoning_content, undefined);
  assert.equal(plainAssistants[1].reasoning_content, undefined);
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

test("codec：纯文字轮 continuation（空 toolCallIds）往返解析", () => {
  const anthropicTextRound = parseProviderContinuationState({
    protocol: "anthropic_messages",
    toolCallIds: [],
    blocks: [thinking("final reasoning", "sig-final")],
  });
  assert.deepEqual(anthropicTextRound, {
    protocol: "anthropic_messages",
    toolCallIds: [],
    blocks: [thinking("final reasoning", "sig-final")],
  });

  const responsesTextRound = parseProviderContinuationState({
    protocol: "openai_responses",
    toolCallIds: [],
    reasoningItems: [{ type: "reasoning", id: "rs-final" }],
  });
  assert.deepEqual(responsesTextRound, {
    protocol: "openai_responses",
    toolCallIds: [],
    reasoningItems: [{ type: "reasoning", id: "rs-final" }],
  });
  assert.equal("anchorCallId" in responsesTextRound, false);

  const chatTextRound = parseProviderContinuationState({
    protocol: "openai_chat",
    toolCallIds: [],
    assistantFields: { reasoning_content: "plain text round" },
  });
  assert.deepEqual(chatTextRound, {
    protocol: "openai_chat",
    toolCallIds: [],
    assistantFields: { reasoning_content: "plain text round" },
  });
});

test("纯文字轮响应也产出 continuation：三协议 final 轮思考不再丢弃", async () => {
  const jsonResponse = (payload) => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  const originalFetch = globalThis.fetch;
  const provider = { key: "test", name: "test", api_key: "k" };

  try {
    globalThis.fetch = async () => jsonResponse({
      content: [{ type: "thinking", thinking: "final thought", signature: "sig" }, { type: "text", text: "done" }],
      stop_reason: "end_turn",
    });
    const anthropic = await new AnthropicAdapter().complete({
      provider: { ...provider, provider_type: "anthropic" },
      model: "test-model",
      messages: [{ role: "user", content: "go" }],
    });
    assert.deepEqual(anthropic.providerContinuation, {
      protocol: "anthropic_messages",
      toolCallIds: [],
      blocks: [thinking("final thought", "sig")],
    });

    globalThis.fetch = async () => jsonResponse({
      choices: [{ message: { role: "assistant", content: "done", reasoning_content: "final thought" }, finish_reason: "stop" }],
    });
    const chat = await new OpenAiChatAdapter().complete({
      provider: { ...provider, provider_type: "openai_chat" },
      model: "test-model",
      messages: [{ role: "user", content: "go" }],
    });
    assert.deepEqual(chat.providerContinuation, {
      protocol: "openai_chat",
      toolCallIds: [],
      assistantFields: { reasoning_content: "final thought" },
    });

    globalThis.fetch = async () => jsonResponse({
      status: "completed",
      output: [
        { type: "reasoning", id: "rs-final", encrypted_content: "RSN(enc)" },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      ],
    });
    const responses = await new OpenAiResponsesAdapter().complete({
      provider: { ...provider, provider_type: "openai_resp" },
      model: "test-model",
      messages: [{ role: "user", content: "go" }],
    });
    assert.deepEqual(responses.providerContinuation, {
      protocol: "openai_responses",
      toolCallIds: [],
      reasoningItems: [{ type: "reasoning", id: "rs-final", encrypted_content: "RSN(enc)" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
