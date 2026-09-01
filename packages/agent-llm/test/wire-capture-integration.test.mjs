import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AnthropicAdapter } from "../dist/providers/anthropic.js";
import { configureWireCapture } from "../dist/wire-capture.js";

// 走真实 provider 适配器（SDK → resolveSdkFetch → 抓取）的端到端验证：
// stub globalThis.fetch 依赖"包装层惰性读 globalThis.fetch"的语义不被破坏。
const sseBody = (events) => events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`).join("");

test("wire 抓取穿过真实 SDK 调用链记录原始 SSE 且不影响适配器解析", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-capture-e2e-"));
  const events = [
    {
      type: "message_start",
      data: {
        type: "message_start",
        message: { usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 0 } },
      },
    },
    { type: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { type: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } } },
    { type: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { type: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } } },
    { type: "message_stop", data: { type: "message_stop" } },
  ];
  const body = sseBody(events);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { headers: { "content-type": "text/event-stream" } });
  configureWireCapture({ dir });
  try {
    const adapter = new AnthropicAdapter();
    const result = await adapter.stream(
      {
        provider: { key: "pqy_test", name: "test", provider_type: "anthropic", api_key: "k" },
        model: "glm-test",
        messages: [{ role: "user", content: "hi" }],
      },
      async () => {},
    );
    assert.equal(result.usage.cachedInputTokens, 100);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    assert.equal(files.length, 1, "应产生一个按天 JSONL");
    const records = fs.readFileSync(path.join(dir, files[0]), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const request = records.find((record) => record.kind === "request");
    const response = records.find((record) => record.kind === "response");
    assert.equal(request.provider, "pqy_test");
    assert.equal(request.body.model, "glm-test");
    // Anthropic SDK 走 x-api-key 头：必须脱敏。
    assert.match(request.headers["x-api-key"], /^<redacted:[0-9a-f]{8}>$/);
    assert.equal(response.stream, true);
    assert.equal(response.body, body, "原始 SSE 逐字节落盘");
    assert.equal(response.interrupted, undefined);
  } finally {
    configureWireCapture(null);
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
