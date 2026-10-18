import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { McpService } from "../dist/index.js";
import { SdkMcpClient } from "../dist/services/mcp/sdk-mcp-client.js";

const completed = { content: [{ type: "text", text: "rendered" }] };

async function fixture(t, timeout = 120) {
  const config = {
    name: "timeout_fixture",
    transport: "streamable_http",
    url: "http://127.0.0.1:9/mcp",
    auto_connect: false,
    timeout,
  };
  const server = new Server({ name: "timeout-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new SdkMcpClient(config);
  // Keep the real SDK request/timeout machinery, with an in-process transport.
  client.transport = clientTransport;
  const calls = [];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "render", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => new Promise((resolve) => {
    calls.push({ request, signal: extra.signal, complete: () => resolve(completed) });
  }));
  t.after(async () => {
    for (const call of calls) call.complete();
    client.close();
    await server.close();
  });
  await Promise.all([server.connect(serverTransport), client.connect()]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return { client, config, calls };
}

function observe(promise) {
  const observation = { settled: false };
  promise.then(
    () => { observation.settled = true; },
    () => { observation.settled = true; },
  );
  return observation;
}

for (const withSignal of [false, true]) {
  test(`120s tool call survives the SDK 60s default (${withSignal ? "with" : "without"} cancellation signal)`, async (t) => {
    const { client, calls } = await fixture(t);
    const signal = withSignal ? new AbortController().signal : undefined;
    const pending = client.callTool("render", { project: "map.html" }, { trace: "render-1" }, signal);
    const observation = observe(pending);
    await nextTurn();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(90_000);
    await nextTurn();
    assert.equal(observation.settled, false, "a 120s request must still be pending after 90s");
    assert.deepEqual(calls[0].request.params.arguments, { project: "map.html" });
    assert.equal(calls[0].request.params._meta.trace, "render-1");
    calls[0].complete();
    assert.deepEqual(await pending, completed);
  });
}

test("tool call times out at the configured deadline", async (t) => {
  const { client, calls } = await fixture(t, 2);
  const pending = client.callTool("render", {});
  const observation = observe(pending);
  await nextTurn();
  t.mock.timers.tick(1_999);
  await nextTurn();
  assert.equal(observation.settled, false);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(observation.settled, true, "the configured 2s deadline must terminate the request");
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, ErrorCode.RequestTimeout);
    assert.equal(error.data.timeout, 2_000);
    return true;
  });
  assert.equal(calls[0].signal.aborted, true);
});

test("caller cancellation still aborts a long tool call", async (t) => {
  const { client, calls } = await fixture(t);
  const controller = new AbortController();
  const reason = new Error("render cancelled");
  const pending = client.callTool("render", {}, undefined, controller.signal);
  const rejection = assert.rejects(pending, /render cancelled/);
  await nextTurn();
  controller.abort(reason);
  await rejection;
  await nextTurn();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls.length, 1);
});

test("updating the connected server timeout applies to the next tool call without reconnecting", async (t) => {
  const { client, config, calls } = await fixture(t, 1);
  const service = new McpService({ configPath: "" });
  await service.addServer(config, { connect: false });
  service.connections.set(config.name, {
    serverName: config.name,
    config: structuredClone(service.ensureServer(config.name)),
    status: "connected",
    errorMessage: null,
    client,
    tools: client.tools,
    resources: [],
    prompts: [],
    capabilities: client.getServerCapabilities(),
    reconnectAttempts: 0,
  });
  await service.updateServer(config.name, { timeout: 120 }, { connect: false });
  assert.equal(service.connections.get(config.name).client, client);
  const pending = service.callTool(config.name, "render", {});
  const observation = observe(pending);
  await nextTurn();
  t.mock.timers.tick(90_000);
  await nextTurn();
  assert.equal(observation.settled, false, "the SDK must use the updated timeout rather than its initial 1s value");
  calls[0].complete();
  assert.equal((await pending).success, true);
});
