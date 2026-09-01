import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configureWireCapture,
  wrapFetchWithWireCapture,
} from "../dist/wire-capture.js";

function tempCaptureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wire-capture-"));
}

async function readJsonl(dir) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  const lines = files.flatMap((name) =>
    fs.readFileSync(path.join(dir, name), "utf8").trim().split("\n").filter(Boolean));
  return lines.map((line) => JSON.parse(line));
}

test("captures JSON request and response verbatim while the consumer reads the full body", async () => {
  const dir = tempCaptureDir();
  configureWireCapture({ dir });
  const base = async () => new Response(JSON.stringify({
    usage: { input_tokens: 42, output_tokens: 7 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const wrapped = wrapFetchWithWireCapture(base, { provider: "ds_deepseek" });

  const response = await wrapped("https://gw.example/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-secret" },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] }),
  });
  const consumed = await response.json();
  assert.equal(consumed.usage.input_tokens, 42);

  const records = await readJsonl(dir);
  const request = records.find((record) => record.kind === "request");
  const responseBody = records.find((record) => record.kind === "response");
  assert.equal(request.provider, "ds_deepseek");
  assert.equal(request.url, "https://gw.example/v1/chat/completions");
  assert.equal(request.body.model, "deepseek-v4-flash");
  // 敏感头脱敏，值不可见但可对账。
  assert.match(request.headers.authorization, /^<redacted:[0-9a-f]{8}>$/);
  assert.equal(responseBody.status, 200);
  assert.equal(responseBody.stream, false);
  assert.equal(JSON.parse(responseBody.body).usage.input_tokens, 42);
  configureWireCapture(null);
});

test("captures streamed SSE tail after the consumer finishes the stream", async () => {
  const dir = tempCaptureDir();
  configureWireCapture({ dir });
  const sseText = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"output_tokens":1}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":99}}\n\n',
    "event: message_stop\ndata: {}\n\n",
  ].join("");
  const base = async () => new Response(sseText, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const wrapped = wrapFetchWithWireCapture(base, { provider: "pqy_zhipuai" });

  const response = await wrapped("https://gw.example/v1/messages", {
    method: "POST",
    headers: { "x-api-key": "zk-secret" },
    body: JSON.stringify({ model: "glm-5.3-flash", messages: [] }),
  });
  const consumedText = await response.text();
  assert.equal(consumedText, sseText);

  const records = await readJsonl(dir);
  const tail = records.find((record) => record.kind === "response");
  assert.equal(tail.stream, true);
  assert.equal(tail.body, sseText);
  const request = records.find((record) => record.kind === "request");
  assert.match(request.headers["x-api-key"], /^<redacted:[0-9a-f]{8}>$/);
  configureWireCapture(null);
});

test("records an interrupted response and rethrows when the base fetch fails", async () => {
  const dir = tempCaptureDir();
  configureWireCapture({ dir });
  const base = async () => {
    throw new TypeError("fetch failed");
  };
  const wrapped = wrapFetchWithWireCapture(base, { provider: "p" });

  await assert.rejects(() => wrapped("https://gw.example/v1/x", { method: "POST" }), /fetch failed/);
  const records = await readJsonl(dir);
  const tail = records.find((record) => record.kind === "response");
  assert.equal(tail.interrupted, true);
  assert.equal(tail.error, "fetch failed");
  configureWireCapture(null);
});

test("capture stays silent when disabled and honors the provider allowlist", async () => {
  const dir = tempCaptureDir();
  configureWireCapture(null);
  let baseCalls = 0;
  const base = async () => {
    baseCalls += 1;
    return new Response("{}", { status: 200 });
  };
  const wrapped = wrapFetchWithWireCapture(base, { provider: "p" });
  await wrapped("https://gw.example/v1/x");
  assert.equal(baseCalls, 1);
  assert.deepEqual(fs.readdirSync(dir), []);

  configureWireCapture({ dir, providers: ["ds_deepseek"] });
  const selected = wrapFetchWithWireCapture(base, { provider: "ds_deepseek" });
  const skipped = wrapFetchWithWireCapture(base, { provider: "pqy_zhipuai" });
  await selected("https://gw.example/v1/a", { method: "POST", body: "{}" });
  await skipped("https://gw.example/v1/b", { method: "POST", body: "{}" });
  const records = await readJsonl(dir);
  assert.equal(records.filter((record) => record.kind === "request").length, 1);
  assert.equal(records.find((record) => record.kind === "request").provider, "ds_deepseek");
  configureWireCapture(null);
});
