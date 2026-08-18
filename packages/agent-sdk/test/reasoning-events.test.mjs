import assert from "node:assert/strict";
import test from "node:test";

import { KernelContext, NativeHybridProtocol, XmlProtocol } from "../dist/index.js";

/** 收集 kernel 事件的数组 EventSink。 */
const collectingSink = () => {
  const events = [];
  return { events, emit: (event) => { events.push(event); } };
};

/** 最小 RuntimeSession（协议 invoke 只读 profile/provider/modelName/signal 等展示字段）。 */
const fakeSession = () => ({
  profile: {
    agentName: "tester",
    llmTiers: {},
    behavior: {},
  },
  provider: { key: "test", name: "test", provider_type: "openai_chat", api_key: "k" },
  modelName: "test-model",
  conversation: [{ role: "user", content: "hi" }],
  sessionId: "s-1",
  runId: "r-1",
  taskId: null,
  requestId: null,
  rootCallId: null,
  threadKey: "root",
  parentCallId: null,
  startRound: 0,
  resumeToolResults: new Map(),
});

/** fake LlmClient：按脚本逐 chunk 回放（含 reasoning 增量），返回最终 result。 */
const fakeLlm = (chunks, result) => ({
  stream: async (_request, onChunk) => {
    for (const chunk of chunks) await onChunk(chunk);
    return result;
  },
});

const getNoTools = () => [];

test("XmlProtocol 流式透传 reasoning 增量并发出 reasoning_complete", async () => {
  const sink = collectingSink();
  const protocol = new XmlProtocol({
    llm: fakeLlm(
      [
        { content: "", reasoning: "think " },
        { content: "", reasoning: "twice" },
        { content: "<intent>act</intent><final_answer>done</final_answer>" },
      ],
      { content: "<intent>act</intent><final_answer>done</final_answer>", reasoning: "think twice", finishReason: "stop" },
    ),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 0);

  assert.equal(outcome.kind, "final");
  const reasoningDeltas = sink.events.filter((e) => e.type === "reasoning_delta");
  assert.deepEqual(reasoningDeltas.map((e) => e.content), ["think ", "twice"]);
  assert.deepEqual(reasoningDeltas.map((e) => e.round), [0, 0]);
  const complete = sink.events.filter((e) => e.type === "reasoning_complete");
  assert.equal(complete.length, 1);
  assert.equal(complete[0].content, "think twice");
  // reasoning 在 first_token 之前到达：首个 reasoning chunk 即触发 first_token。
  const firstTokenIndex = sink.events.findIndex((e) => e.type === "first_token");
  assert.ok(firstTokenIndex >= 0);
  assert.equal(sink.events[firstTokenIndex + 1]?.type, "reasoning_delta");
});

test("NativeHybridProtocol 流式透传 reasoning 增量并发出 reasoning_complete", async () => {
  const sink = collectingSink();
  const protocol = new NativeHybridProtocol({
    llm: fakeLlm(
      [
        { content: "", reasoning: "ponder " },
        { content: "", reasoning: "deep" },
        { content: "<final_answer>answer</final_answer>" },
      ],
      { content: "<final_answer>answer</final_answer>", reasoning: "ponder deep", finishReason: "stop" },
    ),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 2);

  assert.equal(outcome.kind, "final");
  const reasoningDeltas = sink.events.filter((e) => e.type === "reasoning_delta");
  assert.deepEqual(reasoningDeltas.map((e) => e.content), ["ponder ", "deep"]);
  assert.deepEqual(reasoningDeltas.map((e) => e.round), [2, 2]);
  const complete = sink.events.filter((e) => e.type === "reasoning_complete");
  assert.equal(complete.length, 1);
  assert.equal(complete[0].content, "ponder deep");
  // 无 reasoning 时不应发出任何 reasoning 事件（由下一个用例覆盖的负向路径在 provider 层保证）。
});

test("NativeHybridProtocol 无 reasoning 时不发 reasoning 事件", async () => {
  const sink = collectingSink();
  const protocol = new NativeHybridProtocol({
    llm: fakeLlm(
      [{ content: "<final_answer>plain</final_answer>" }],
      { content: "<final_answer>plain</final_answer>", finishReason: "stop" },
    ),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 0);

  assert.equal(outcome.kind, "final");
  assert.equal(sink.events.some((e) => e.type === "reasoning_delta" || e.type === "reasoning_complete"), false);
});
