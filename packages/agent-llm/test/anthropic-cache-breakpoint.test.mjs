import assert from "node:assert/strict";
import test from "node:test";

import { buildAnthropicBody } from "../dist/providers/anthropic.js";

const provider = (extra = {}) => ({
  key: "test",
  name: "test",
  provider_type: "anthropic",
  api_key: "k",
  ...extra,
});

const request = (messages, extra = {}) => ({
  provider: provider(),
  model: "test-model",
  messages,
  ...extra,
});

test("Anthropic 将移动缓存断点放在最新 tool_result", () => {
  const body = buildAnthropicBody(request([
    { role: "system", content: "system prompt" },
    { role: "user", content: "read the file" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      }],
    },
    { role: "tool", tool_call_id: "call-1", content: "file contents" },
  ]));

  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  assert.equal(body.messages[1].content[0].type, "tool_use");
  assert.equal(body.messages[1].content[0].cache_control, undefined);
  assert.equal(body.messages[2].content[0].type, "tool_result");
  assert.deepEqual(body.messages[2].content[0].cache_control, { type: "ephemeral" });
});

test("Anthropic 首轮 user 文本也成为移动缓存断点", () => {
  const body = buildAnthropicBody(request([
    { role: "system", content: "system prompt" },
    { role: "user", content: "first request" },
  ]));

  assert.deepEqual(body.messages[0].content[0], {
    type: "text",
    text: "first request",
    cache_control: { type: "ephemeral" },
  });
});

test("Anthropic 最新 assistant 仍标记最后一个有效内容块", () => {
  const body = buildAnthropicBody(request([
    { role: "user", content: "run it" },
    {
      role: "assistant",
      content: "calling tool",
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "shell", arguments: "{}" },
      }],
    },
  ]));

  assert.equal(body.messages[1].content[0].cache_control, undefined);
  assert.deepEqual(body.messages[1].content[1].cache_control, { type: "ephemeral" });
});

test("Anthropic 关闭 prompt caching 时不写任何缓存断点", () => {
  const body = buildAnthropicBody({
    ...request([
      { role: "system", content: "system prompt" },
      { role: "user", content: "run it" },
      { role: "assistant", content: "done" },
    ], {
      tools: [{
        type: "function",
        function: { name: "shell", description: "run command", parameters: { type: "object" } },
      }],
    }),
    provider: provider({ supports_prompt_caching: false }),
  });

  assert.equal(JSON.stringify(body).includes('"cache_control"'), false);
});
