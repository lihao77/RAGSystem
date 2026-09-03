import assert from "node:assert/strict";
import test from "node:test";

import { KernelContext, XmlProtocol } from "../dist/index.js";

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

/** fake LlmClient：每次 stream 调用按脚本序消费一个 {chunks, result}（修复重试每次调用取下一个）。 */
const scriptedLlm = (scripts) => {
  let call = 0;
  const requests = [];
  return {
    requests,
    stream: async (request, onChunk) => {
      requests.push(request);
      const { chunks, result } = scripts[Math.min(call, scripts.length - 1)];
      call += 1;
      for (const chunk of chunks) await onChunk(chunk);
      return result;
    },
  };
};

const getNoTools = () => [];

// 失败尝试：裸正文 + 无 name 属性的 <tool>（解析错误：tool tag is missing name attribute）。
const BROKEN_TOOL_CALLS = '<tool_calls><tool>{ "path": "a.txt" }</tool></tool_calls>';
const VALID_TOOL_CALLS = '<tool_calls><tool name="read"><![CDATA[{ "path": "a.txt" }]]></tool></tool_calls>';

test("修复重试期间不发 intent_complete——该轮文字只在最终成功时派生一次", async () => {
  const sink = collectingSink();
  const llm = scriptedLlm([
    {
      chunks: [{ content: `我先查一下${BROKEN_TOOL_CALLS}` }],
      result: { content: `我先查一下${BROKEN_TOOL_CALLS}`, finishReason: "tool_calls" },
    },
    {
      chunks: [{ content: `重新查${VALID_TOOL_CALLS}` }],
      result: { content: `重新查${VALID_TOOL_CALLS}`, finishReason: "tool_calls" },
    },
  ]);
  const protocol = new XmlProtocol({ llm, events: sink, getTools: getNoTools });
  const ctx = KernelContext.create(fakeSession());
  const outcome = await protocol.invoke(ctx, 0);

  // 第一次解析失败 → 追加 feedback 重试，第二次成功。
  assert.equal(llm.requests.length, 2);
  assert.equal(outcome.kind, "tool_calls");
  assert.equal(outcome.assistantMessage.content, "重新查");

  // 两次尝试的正文都流式透传（output_delta），但整轮只派生一次 intent_complete——
  // 内容是最终成功尝试的全文。重试前若先定格失败尝试的正文，投影端会把该轮
  // 封口（intentComplete=true），重试 delta 只能落入幻影新轮：同文两份且吞噬
  // 下一轮正文（见 execution-tree 投影的 ensureActiveRound）。
  const deltas = sink.events.filter((e) => e.type === "output_delta");
  assert.deepEqual(deltas.map((e) => e.content), ["我先查一下", "重新查"]);
  const notes = sink.events.filter((e) => e.type === "intent_complete");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, "重新查");
  assert.equal(notes[0].round, 0);
  // 唯一一次定稿必须晚于全部正文增量（轮末派生，不是中途冻结）。
  const lastDeltaIndex = sink.events.map((e) => e.type).lastIndexOf("output_delta");
  const noteIndex = sink.events.findIndex((e) => e.type === "intent_complete");
  assert.ok(lastDeltaIndex >= 0 && noteIndex > lastDeltaIndex);
});

test("修复重试耗尽抛错时全程不发 intent_complete（失败尝试的正文不定格为轮说明）", async () => {
  const sink = collectingSink();
  const llm = scriptedLlm([
    { chunks: [{ content: `第一次${BROKEN_TOOL_CALLS}` }], result: { content: `第一次${BROKEN_TOOL_CALLS}`, finishReason: "tool_calls" } },
    { chunks: [{ content: `第二次${BROKEN_TOOL_CALLS}` }], result: { content: `第二次${BROKEN_TOOL_CALLS}`, finishReason: "tool_calls" } },
    { chunks: [{ content: `第三次${BROKEN_TOOL_CALLS}` }], result: { content: `第三次${BROKEN_TOOL_CALLS}`, finishReason: "tool_calls" } },
  ]);
  const protocol = new XmlProtocol({ llm, events: sink, getTools: getNoTools });
  const ctx = KernelContext.create(fakeSession());

  // 初次 + 2 次修复重试全部失败 → 抛错。正文留在投影端本轮 text 通道（中断轮
  // 段尾输出），不产生任何定稿信号——旧版会在每次重试前把失败尝试定格成
  // intent，制造"定稿了又重写"的闪变。
  await assert.rejects(() => protocol.invoke(ctx, 0), /XML protocol repair exceeded max attempts/);
  assert.equal(llm.requests.length, 3);
  assert.equal(sink.events.some((e) => e.type === "intent_complete"), false);
});
