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

/** fake LlmClient：按脚本逐 chunk 回放，返回最终 result。 */
const fakeLlm = (chunks, result) => ({
  stream: async (_request, onChunk) => {
    for (const chunk of chunks) await onChunk(chunk);
    return result;
  },
});

/** 逐次调用回放不同脚本的 fake LlmClient（协议修复重试场景）。 */
const scriptedLlm = (rounds) => {
  let call = 0;
  return {
    stream: async (_request, onChunk) => {
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      for (const chunk of round.chunks) await onChunk(chunk);
      return round.result;
    },
  };
};

const getNoTools = () => [];

test("XmlProtocol 裸正文边流边发 output_delta，纯文本判为 final", async () => {
  const sink = collectingSink();
  const protocol = new XmlProtocol({
    llm: fakeLlm(
      [
        { content: "答案" },
        { content: "是 42" },
      ],
      { content: "答案是 42", finishReason: "stop" },
    ),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 0);

  assert.equal(outcome.kind, "final");
  assert.equal(outcome.finalAnswer, "答案是 42");
  const deltas = sink.events.filter((e) => e.type === "output_delta");
  assert.deepEqual(deltas.map((e) => e.content), ["答案", "是 42"]);
  // 无标签化：intent_* 不再流式发射。
  assert.equal(sink.events.some((e) => e.type === "intent_delta"), false);
  assert.equal(sink.events.some((e) => e.type === "intent_complete"), false);
});

test("XmlProtocol 工具轮裸正文以派生 intent_complete 归档", async () => {
  const sink = collectingSink();
  const toolCallsXml = '<tool_calls><tool name="read"><![CDATA[{ "path": "a.txt" }]]></tool></tool_calls>';
  const protocol = new XmlProtocol({
    llm: fakeLlm(
      [
        { content: "先读一下文件" },
        { content: toolCallsXml },
      ],
      { content: `先读一下文件${toolCallsXml}`, finishReason: "tool_calls" },
    ),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 1);

  assert.equal(outcome.kind, "tool_calls");
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.calls[0].toolName, "read");
  // 轮末派生：动作说明经 intent_complete 归档（过程树/前端清气泡共用此信号）。
  const notes = sink.events.filter((e) => e.type === "intent_complete");
  assert.deepEqual(notes.map((e) => e.content), ["先读一下文件"]);
  assert.deepEqual(notes.map((e) => e.round), [1]);
  // 助手消息正文即动作说明（msg_type=ROUND 行的 content）。
  assert.equal(outcome.assistantMessage.content, "先读一下文件");
  assert.equal(outcome.assistantMessage.tool_calls.length, 1);
});

test("XmlProtocol 剥离旧协议标签：内容按裸文本透传", async () => {
  const sink = collectingSink();
  const legacy = "<intent>处理中</intent><final_answer>完成了</final_answer>";
  const protocol = new XmlProtocol({
    llm: fakeLlm([{ content: legacy }], { content: legacy, finishReason: "stop" }),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 0);

  // 标签本身丢弃、内容透传，不泄漏进答案。
  assert.equal(outcome.kind, "final");
  assert.equal(outcome.finalAnswer.includes("<"), false);
  assert.equal(outcome.finalAnswer, "处理中完成了");
});

test("XmlProtocol 流结束冲刷扣留的尾部缓冲", async () => {
  const sink = collectingSink();
  // 末尾 "<" 是疑似闭合标签前缀，会被解析器扣留到 finish() 才冲出。
  const protocol = new XmlProtocol({
    llm: fakeLlm(
      [
        { content: "结果<" },
        { content: "d" },
      ],
      { content: "结果<d", finishReason: "stop" },
    ),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 0);

  assert.equal(outcome.kind, "final");
  assert.equal(outcome.finalAnswer, "结果<d");
});

test("XmlProtocol 空响应触发修复重试，重试产出正文判为 final", async () => {
  const sink = collectingSink();
  const protocol = new XmlProtocol({
    llm: scriptedLlm([
      { chunks: [{ content: "" }], result: { content: "", finishReason: "stop" } },
      { chunks: [{ content: "重试后的回答" }], result: { content: "重试后的回答", finishReason: "stop" } },
    ]),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 0);

  assert.equal(outcome.kind, "final");
  assert.equal(outcome.finalAnswer, "重试后的回答");
});

test("XmlProtocol 非流式：裸文本直判 final，旧标签剥离", async () => {
  const sink = collectingSink();
  const legacy = "<final_answer>离线回答</final_answer>";
  const protocol = new XmlProtocol({
    llm: {
      stream: undefined,
      complete: async () => ({ content: legacy, finishReason: "stop" }),
    },
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 0);

  assert.equal(outcome.kind, "final");
  assert.equal(outcome.finalAnswer, "离线回答");
});

test("NativeHybridProtocol 裸正文流式 + FC 工具轮派生 intent_complete", async () => {
  const sink = collectingSink();
  const fcCall = {
    id: "call-1",
    type: "function",
    function: { name: "search", arguments: "{\"q\":\"ragsystem\"}" },
  };
  const protocol = new NativeHybridProtocol({
    llm: fakeLlm(
      [
        { content: "搜索相关" },
        { content: "资料" },
        { toolCalls: [fcCall] },
      ],
      { content: "搜索相关资料", toolCalls: [fcCall], finishReason: "tool_calls" },
    ),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 3);

  assert.equal(outcome.kind, "tool_calls");
  assert.equal(outcome.calls[0].toolName, "search");
  assert.deepEqual(outcome.calls[0].arguments, { q: "ragsystem" });
  const notes = sink.events.filter((e) => e.type === "intent_complete");
  assert.deepEqual(notes.map((e) => e.content), ["搜索相关资料"]);
  assert.deepEqual(notes.map((e) => e.round), [3]);
  assert.equal(outcome.assistantMessage.content, "搜索相关资料");
});

test("NativeHybridProtocol 纯文本无工具判为 final 且不发 intent_complete", async () => {
  const sink = collectingSink();
  const protocol = new NativeHybridProtocol({
    llm: fakeLlm(
      [
        { content: "直接" },
        { content: "回答" },
      ],
      { content: "直接回答", finishReason: "stop" },
    ),
    events: sink,
    getTools: getNoTools,
  });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 0);

  assert.equal(outcome.kind, "final");
  assert.equal(outcome.finalAnswer, "直接回答");
  assert.equal(sink.events.some((e) => e.type === "intent_complete"), false);
  const deltas = sink.events.filter((e) => e.type === "output_delta");
  assert.deepEqual(deltas.map((e) => e.content), ["直接", "回答"]);
});
