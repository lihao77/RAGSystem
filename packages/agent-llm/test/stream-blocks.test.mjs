import assert from "node:assert/strict";
import test from "node:test";

import { StreamingBlocks } from "../dist/providers/internal/stream-blocks.js";

test("StreamingBlocks 按 index 寻址追加并在定稿时剥离暂存字段", () => {
  const blocks = new StreamingBlocks();
  blocks.open({ kind: "toolCall", index: 2, id: "call-2", name: "read_file", partialJson: "" });
  blocks.appendToolArguments(2, '{"pa');
  blocks.appendToolArguments(2, 'th":"a"}');
  blocks.open({ kind: "toolCall", index: 0, id: "call-0", name: "write_file", partialJson: "{}" });

  const calls = blocks.toolCalls();
  assert.deepEqual(calls.map((call) => call.id), ["call-0", "call-2"]);
  assert.equal(calls[1].function.arguments, '{"path":"a"}');
  // 定稿结果不含 partialJson 等暂存键
  for (const call of calls) assert.deepEqual(Object.keys(call), ["id", "type", "function"]);
});

test("StreamingBlocks 同 index 同 kind 幂等，跨 kind 重建", () => {
  const blocks = new StreamingBlocks();
  const first = blocks.open({ kind: "thinking", index: 1, thinking: "a", signature: "" });
  blocks.open({ kind: "thinking", index: 1, thinking: "", signature: "" });
  blocks.appendThinking(1, "b");
  assert.equal(first.thinking, "ab");
  blocks.open({ kind: "text", index: 1, text: "rebuild" });
  assert.equal(blocks.find(1).kind, "text");
});

test("StreamingBlocks 文本按块顺序拼接，无签名思考块不进续传态", () => {
  const blocks = new StreamingBlocks();
  blocks.appendText(3, "world");
  blocks.appendText(0, "hello ");
  blocks.appendThinking(1, "secret", );
  blocks.appendSignature(1, "sig");
  blocks.appendThinking(2, "unsigned");
  assert.equal(blocks.text(), "hello world");
  assert.deepEqual(blocks.reasoningBlocks(), [{ type: "thinking", thinking: "secret", signature: "sig" }]);
  assert.equal(blocks.reasoningText(), "secretunsigned");
  assert.deepEqual(blocks.reasoningEntries().map((entry) => entry.index), [1]);
});

test("StreamingBlocks 未定名工具块保留在 toolCallBlocks 供去重/计数", () => {
  const blocks = new StreamingBlocks();
  blocks.open({ kind: "toolCall", index: 0, id: "call-0", name: "", partialJson: "" });
  assert.equal(blocks.toolCalls().length, 0);
  assert.equal(blocks.toolCallBlocks().length, 1);
  assert.deepEqual(blocks.toolCallBlocks().map((block) => block.id), ["call-0"]);
});
