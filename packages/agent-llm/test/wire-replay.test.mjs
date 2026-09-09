/**
 * wire-capture → 回放/夹具管道自证：经真实抓取链路（configureWireCapture +
 * wrapFetchWithWireCapture 旁路）录制一次 anthropic 流式会话，再用 replayFetch
 * 回放同一会话，断言适配器两次解析结果一致——证明"抓的真实会话可以直接变成回归"，
 * 不需要手工翻译线体。夹具导出（toWireFixture）另做形状断言。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AnthropicAdapter } from "../dist/providers/anthropic.js";
import { configureWireCapture } from "../dist/wire-capture.js";
import { readWireCapture, replayFetch, toWireFixture } from "./helpers/wire-replay.mjs";

const SSE_BODY = [
  { type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello " } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "wire" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

const streamRequest = () => ({
  provider: {
    key: "anthropic",
    name: "Anthropic",
    provider_type: "anthropic",
    api_key: "secret",
    api_endpoint: "https://api.anthropic.com",
  },
  model: "claude-test",
  messages: [{ role: "user", content: "hi" }],
});

test("wire-capture 会话可回放：真实抓取链路录制，回放解析结果与首次一致", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(SSE_BODY, { headers: { "content-type": "text/event-stream" } });
  configureWireCapture({ dir });
  try {
    const firstChunks = [];
    const first = await new AnthropicAdapter().stream(streamRequest(), async (chunk) => {
      firstChunks.push(chunk.content);
    });

    // response 行在消费完流后异步落盘，轮询等待（响应旁路 tee 收尾）。
    const file = await waitForResponseLine(dir, 5_000);
    configureWireCapture(null);
    globalThis.fetch = originalFetch;

    const exchanges = readWireCapture(file);
    assert.equal(exchanges.length, 1);
    assert.ok(exchanges[0].response, "抓取应配对出 request/response 行");
    assert.equal(exchanges[0].response.interrupted, undefined);

    globalThis.fetch = replayFetch(exchanges);
    try {
      const replayChunks = [];
      const replay = await new AnthropicAdapter().stream(streamRequest(), async (chunk) => {
        replayChunks.push(chunk.content);
      });
      assert.deepEqual(replayChunks, firstChunks);
      assert.deepEqual(replayChunks, ["hello ", "wire"]);
      assert.equal(replay.content, first.content);
      assert.equal(replay.content, "hello wire");
      assert.deepEqual(replay.usage, first.usage);
      assert.deepEqual(replay.finishReason, first.finishReason);
      assert.equal(replay.finishReason, "end_turn");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    configureWireCapture(null);
    globalThis.fetch = originalFetch;
  }
});

test("toWireFixture 剥离 id/ts 易变字段，保留方法/线体与脱敏头表", () => {
  const fixture = toWireFixture({
    id: "abc",
    provider: "anthropic",
    request: { id: "abc", ts: "2026-09-09T00:00:00Z", kind: "request", provider: "anthropic", method: "POST", url: "https://x.test/v1/messages", headers: { "x-api-key": "<redacted:12345678>" }, body: { model: "m" } },
    response: { id: "abc", ts: "2026-09-09T00:00:01Z", kind: "response", provider: "anthropic", status: 200, headers: { "content-type": "text/event-stream" }, stream: true, body: "data: ..." },
  });
  assert.deepEqual(fixture, {
    provider: "anthropic",
    request: { method: "POST", url: "https://x.test/v1/messages", headers: { "x-api-key": "<redacted:12345678>" }, body: { model: "m" } },
    response: { status: 200, headers: { "content-type": "text/event-stream" }, stream: true, body: "data: ..." },
  });
});

test("replayFetch 匹配耗尽时响亮报错并列出剩余可回放键", async () => {
  const exchanges = [
    { id: "1", provider: "p", method: "POST", request: { method: "POST", url: "https://x.test/v1/messages" }, response: { status: 200, headers: {}, body: "{}" } },
  ];
  const fetch = replayFetch(exchanges);
  await fetch("https://x.test/v1/messages", { method: "POST" });
  await assert.rejects(
    fetch("https://x.test/v1/messages", { method: "POST" }),
    /无可回放交换 POST \/v1\/messages/,
  );
});

function waitForResponseLine(dir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith(".jsonl")) continue;
          const file = path.join(dir, name);
          if (fs.readFileSync(file, "utf8").includes('"kind":"response"')) {
            resolve(file);
            return;
          }
        }
      } catch {
        // 读目录/文件瞬态失败（写入中）继续等
      }
      if (Date.now() > deadline) {
        reject(new Error("等待 wire capture response 行落盘超时"));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}
