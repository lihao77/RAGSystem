import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeToolPairing } from "../dist/llm-protocol/tool-pairing.js";

function assistantWithCalls(...ids) {
  return {
    role: "assistant",
    content: "intent",
    tool_calls: ids.map((id) => ({ id, type: "function", function: { name: "grep", arguments: "{}" } })),
  };
}

function toolResult(id) {
  return { role: "tool", tool_call_id: id, name: "grep", content: `result-${id}` };
}

test("正常配对的序列原样通过", () => {
  const messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    assistantWithCalls("a", "b"),
    toolResult("a"),
    toolResult("b"),
    { role: "assistant", content: "final" },
  ];
  const result = sanitizeToolPairing(messages);
  assert.equal(result.droppedToolCallIds.length, 0);
  assert.deepEqual(result.messages, messages);
});

test("孤立 tool 消息被丢弃(压缩回补 bug 的复现形态:尾部一串无前置 tool_calls 的 observation)", () => {
  const messages = [
    { role: "assistant", content: "摘要" },
    { role: "user", content: "task" },
    toolResult("orphan-1"),
    toolResult("orphan-2"),
  ];
  const result = sanitizeToolPairing(messages);
  assert.deepEqual(result.droppedToolCallIds, ["orphan-1", "orphan-2"]);
  assert.deepEqual(result.messages.map((m) => m.role), ["assistant", "user"]);
});

test("缺 tool_call_id 的 tool 消息被丢弃", () => {
  const messages = [
    { role: "user", content: "task" },
    { role: "tool", content: "no-id" },
  ];
  const result = sanitizeToolPairing(messages);
  assert.deepEqual(result.droppedToolCallIds, ["(missing)"]);
  assert.equal(result.messages.length, 1);
});

test("悬空 tool_calls(无 tool 结果)不动,留给内核恢复契约", () => {
  const messages = [
    { role: "user", content: "task" },
    assistantWithCalls("dangling"),
  ];
  const result = sanitizeToolPairing(messages);
  assert.equal(result.droppedToolCallIds.length, 0);
  assert.equal(result.messages.length, 2);
});

test("tool 消息顺序在 assistant 之前视为孤立(只看前置)", () => {
  const messages = [
    toolResult("early"),
    assistantWithCalls("early"),
  ];
  const result = sanitizeToolPairing(messages);
  assert.deepEqual(result.droppedToolCallIds, ["early"]);
  assert.equal(result.messages.length, 1);
});
