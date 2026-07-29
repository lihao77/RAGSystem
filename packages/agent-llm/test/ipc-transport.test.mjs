import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OpenAiCompatibleClient } from "../dist/index.js";

test("OpenAI-compatible client supports completion, streaming, and abort over an IPC socket", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-llm-ipc-"));
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\agent-llm-${randomUUID()}`
    : path.join(root, "llm.sock");
  const socketEnv = `AGENT_LLM_TEST_SOCKET_${process.pid}`;
  const previousSocket = process.env[socketEnv];
  process.env[socketEnv] = socketPath;
  const requests = [];
  let notifyAbortStarted;
  const abortStarted = new Promise((resolve) => { notifyAbortStarted = resolve; });
  const server = http.createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    requests.push({ url: request.url, body });
    const content = String(body.messages?.at(-1)?.content ?? "");
    if (content === "abort") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      notifyAbortStarted();
      return;
    }
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"IPC "},"finish_reason":null}]}\n\n');
      response.end('data: {"choices":[{"delta":{"content":"stream"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "IPC completion" }, finish_reason: "stop" }],
    }));
  });
  await listen(server, socketPath);
  t.after(async () => {
    if (previousSocket === undefined) delete process.env[socketEnv];
    else process.env[socketEnv] = previousSocket;
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const client = new OpenAiCompatibleClient();
  const complete = await client.complete(llmRequest("complete", socketEnv, "complete"));
  assert.equal(complete.content, "IPC completion");

  const chunks = [];
  const streamed = await client.stream(llmRequest("stream", socketEnv, "stream"), async (chunk) => {
    chunks.push(chunk.content);
  });
  assert.equal(streamed.content, "IPC stream");
  assert.deepEqual(chunks, ["IPC ", "stream"]);

  const controller = new AbortController();
  const aborted = client.stream(llmRequest("abort", socketEnv, "abort", controller.signal), async () => undefined);
  await abortStarted;
  controller.abort();
  await assert.rejects(aborted, (error) => error?.name === "AbortError");

  assert.deepEqual(requests.map((entry) => entry.url), [
    "/private-token/chat/completions",
    "/private-token/chat/completions",
    "/private-token/chat/completions",
  ]);

  delete process.env[socketEnv];
  await assert.rejects(
    client.complete(llmRequest("missing", socketEnv, "missing")),
    /IPC socket environment variable .* is not configured/,
  );
  process.env[socketEnv] = socketPath;
});

test("OpenAI-compatible client keeps the default HTTP transport", async (t) => {
  const server = http.createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request));
    assert.equal(body.messages.at(-1).content, "http");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "HTTP completion" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => close(server));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const result = await new OpenAiCompatibleClient().complete({
    provider: {
      key: "http",
      name: "HTTP",
      provider_type: "openai_proxy",
      api_endpoint: `http://127.0.0.1:${address.port}`,
      api_key: "placeholder",
    },
    model: "planning-default",
    messages: [{ role: "user", content: "http" }],
  });
  assert.equal(result.content, "HTTP completion");
});

function llmRequest(key, socketEnv, content, signal) {
  return {
    provider: {
      key,
      name: `IPC ${key}`,
      provider_type: "openai_proxy",
      api_endpoint: "http://planning-llm.internal/private-token",
      api_key: "placeholder",
      transport: { type: "ipc_socket", socket_env: socketEnv },
    },
    model: "planning-default",
    messages: [{ role: "user", content }],
    ...(signal ? { signal } : {}),
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
