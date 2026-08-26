import { describe, expect, it } from "vitest";

import { synthesizeExecutionEnvelopes } from "../src/services/sessions/execution-synthesis.js";
import { MSG_TYPE } from "../src/contracts/message-kinds.js";
import type { MessageInfo } from "../src/contracts/session/session.js";

function row(overrides: Partial<MessageInfo>): MessageInfo {
  return {
    id: "row-1",
    seq: 1,
    session_id: "session-1",
    role: "assistant",
    content_parts: [],
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    thread_key: "root",
    child_agent_id: null,
    ...overrides,
  };
}

const runMeta = { run_id: "run-1", agent_name: "agent-1" };

describe("synthesizeExecutionEnvelopes", () => {
  it("replays tool rounds from parts: thinking and intent only when the row carries them", () => {
    const roundRow = row({
      id: "run-1:intent:0",
      seq: 2,
      content_parts: [
        { type: "thinking", text: "用户要查北京天气，调用工具。", round: 1, complete: true },
        { type: "text", text: "我来查一下天气" },
      ],
      metadata: { ...runMeta, msg_type: MSG_TYPE.ROUND, round: 1 },
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "北京" }) },
      }],
    });
    const legacyIntent = row({
      id: "run-1:intent:1",
      seq: 4,
      content_parts: [{ type: "text", text: "再查一下湿度" }],
      metadata: { ...runMeta, msg_type: MSG_TYPE.ROUND, round: 2 },
      tool_calls: [{
        id: "call-2",
        type: "function",
        function: { name: "get_humidity", arguments: "{}" },
      }],
    });

    const fromRound = synthesizeExecutionEnvelopes([roundRow], { sessionId: "session-1", runId: "run-1" });
    const fromLegacy = synthesizeExecutionEnvelopes([legacyIntent], { sessionId: "session-1", runId: "run-1" });

    // 工具轮：agent_started 开篇（带首行 created_at 作 startedAt）+ 思考 + 意图 +
    // 工具调用（无 thinking part 的轮不产生空 reasoning）+ run 终态。
    expect(fromRound.map((env) => [env.type, (env.payload as Record<string, unknown>).phase ?? null])).toEqual([
      ["agent_started", "start"],
      ["stream_output", "reasoning_complete"],
      ["stream_output", "intent_complete"],
      ["tool_call", "start"],
      ["agent_ended", "end"],
    ]);
    expect(fromLegacy.map((env) => env.type)).toEqual(["agent_started", "stream_output", "tool_call", "agent_ended"]);
    // 生命周期开篇/收口携带顶层 timestamp（首行/末行 created_at），供前端推工作时长。
    expect(fromRound[0]!.timestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(fromRound[fromRound.length - 1]!.timestamp).toBe("2026-01-01T00:00:00.000Z");

    const reasoning = fromRound[1]!.payload as Record<string, unknown>;
    expect(reasoning.content).toBe("用户要查北京天气，调用工具。");
    expect(reasoning.round).toBe(0); // metadata.round 是展示序号（kernel round + 1）

    const toolCall = fromRound[3]!.payload as Record<string, unknown>;
    expect(toolCall.tool).toBe("get_weather");
    expect(toolCall.input).toEqual({ city: "北京" });
  });

  it("synthesizes tool results from observation rows and marks failed references", () => {
    const observation = row({
      id: "run-1:tool:call-1",
      seq: 3,
      role: "tool",
      content_parts: [{ type: "text", text: "{\"temp\":25}" }],
      metadata: { ...runMeta, msg_type: MSG_TYPE.OBSERVATION, tool_result_ref: { ok: true } },
      tool_call_id: "call-1",
      name: "get_weather",
    });
    const failed = row({
      id: "run-1:tool:call-9",
      seq: 5,
      role: "tool",
      content_parts: [{ type: "text", text: "boom" }],
      metadata: { ...runMeta, msg_type: MSG_TYPE.OBSERVATION, tool_result_ref: { ok: false } },
      tool_call_id: "call-9",
      name: "danger",
    });

    const envelopes = synthesizeExecutionEnvelopes([observation, failed], { sessionId: "session-1", runId: "run-1" });
    expect(envelopes.map((env) => env.type)).toEqual(["agent_started", "tool_result", "tool_result", "agent_ended"]);
    expect((envelopes[1]!.payload as Record<string, unknown>).observation).toBe("{\"temp\":25}");
    expect((envelopes[1]!.payload as Record<string, unknown>).ok).toBe(true);
    expect((envelopes[2]!.payload as Record<string, unknown>).ok).toBe(false);
  });

  it("emits only reasoning for the final round row, with kernel round derived from tool rounds", () => {
    const intentRound = row({
      id: "run-1:intent:0",
      seq: 2,
      content_parts: [{ type: "text", text: "我来查" }],
      metadata: { ...runMeta, msg_type: MSG_TYPE.ROUND, round: 1 },
      tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }],
    });
    const observation = row({
      id: "run-1:tool:call-1",
      seq: 3,
      role: "tool",
      content_parts: [{ type: "text", text: "data" }],
      metadata: { ...runMeta, msg_type: MSG_TYPE.OBSERVATION },
      tool_call_id: "call-1",
      name: "read",
    });
    const finalRow = row({
      id: "run-1:final",
      seq: 4,
      content_parts: [
        { type: "thinking", text: "查到了，直接回答。", complete: true },
        { type: "text", text: "答案是 42" },
      ],
      metadata: { ...runMeta, msg_type: MSG_TYPE.ROUND },
    });

    const envelopes = synthesizeExecutionEnvelopes([intentRound, observation, finalRow], { sessionId: "session-1", runId: "run-1" });
    const phases = envelopes.map((env) => [env.type, (env.payload as Record<string, unknown>).phase ?? null]);
    // 最终轮只回放思考——正文由消息槽 assistant 行承载（live 的 final 相位同样
    // 把轮 text 让位给消息行，最终答案只出现一次）；agent_started 开篇 + agent_ended 收口。
    expect(phases).toEqual([
      ["agent_started", "start"],
      ["stream_output", "intent_complete"],
      ["tool_call", "start"],
      ["tool_result", "end"],
      ["stream_output", "reasoning_complete"],
      ["agent_ended", "end"],
    ]);
    const finalReasoning = envelopes[4]!.payload as Record<string, unknown>;
    expect(finalReasoning.content).toBe("查到了，直接回答。");
    expect(finalReasoning.round).toBe(1);
  });

  it("derives round 0 for a no-tool run whose only assistant row is the final answer", () => {
    const finalRow = row({
      id: "run-1:final",
      seq: 2,
      content_parts: [{ type: "thinking", text: "不需要工具。", complete: true }],
      metadata: { ...runMeta, msg_type: MSG_TYPE.ROUND },
    });
    const envelopes = synthesizeExecutionEnvelopes([finalRow], { sessionId: "session-1", runId: "run-1" });
    expect(envelopes.map((env) => env.type)).toEqual(["agent_started", "stream_output", "agent_ended"]);
    expect((envelopes[1]!.payload as Record<string, unknown>).round).toBe(0);
  });

  it("keeps legacy assistant_final rows replayable as final rounds", () => {
    const legacyFinal = row({
      id: "run-1:final",
      seq: 4,
      content_parts: [{ type: "thinking", text: "旧思考", complete: true }],
      metadata: { ...runMeta, msg_type: MSG_TYPE.ROUND },
    });
    const envelopes = synthesizeExecutionEnvelopes([legacyFinal], { sessionId: "session-1", runId: "run-1" });
    expect(envelopes.map((env) => env.type)).toEqual(["agent_started", "stream_output", "agent_ended"]);
    expect((envelopes[1]!.payload as Record<string, unknown>).phase).toBe("reasoning_complete");
    expect((envelopes[1]!.payload as Record<string, unknown>).round).toBe(0);
  });

  it("replays terminal-closed dangling tools as interrupted, never as succeeded", () => {
    // 悬空工具行无 tool_result_ref：按 terminal_status 判失败/中断，与 live 终局
    // tool_result envelope 同口径（live 显示 interrupted，历史不得显示成功）。
    const danglingTool = row({
      id: "run-1:tool:call-9",
      seq: 3,
      role: "tool",
      content_parts: [{ type: "text", text: "工具执行被中断：用户主动停止运行" }],
      metadata: {
        ...runMeta,
        msg_type: MSG_TYPE.OBSERVATION,
        terminal_tool_result: true,
        terminal_status: "interrupted",
        boundary_message_id: "u1",
      },
      tool_call_id: "call-9",
      name: "read",
    });
    const envelopes = synthesizeExecutionEnvelopes([danglingTool], { sessionId: "session-1", runId: "run-1" });
    const toolResult = envelopes.find((env) => env.type === "tool_result")!;
    const payload = toolResult.payload as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.status).toBe("interrupted");
  });

  it("terminal runs replay salvage thinking into the tree and close with interrupted agent_ended", () => {    const terminal = row({
      id: "run-1:terminal",
      seq: 4,
      content_parts: [
        { type: "thinking", text: "半截思考", complete: false },
        { type: "text", text: "本次运行已中断" },
      ],
      metadata: { ...runMeta, msg_type: MSG_TYPE.RUN_TERMINAL, terminal_status: "interrupted", terminal_reason: "user abort" },
    });
    const envelopes = synthesizeExecutionEnvelopes([terminal], { sessionId: "session-1", runId: "run-1" });
    // 中断思考进树（树是思考的唯一出口）；正文由消息槽 terminal 行承载；
    // run 终态收口 interrupted + 原因。
    expect(envelopes.map((env) => env.type)).toEqual(["agent_started", "stream_output", "agent_ended"]);
    expect((envelopes[1]!.payload as Record<string, unknown>).phase).toBe("reasoning_complete");
    expect((envelopes[1]!.payload as Record<string, unknown>).content).toBe("半截思考");
    const ended = envelopes[2]!.payload as Record<string, unknown>;
    expect(ended.status).toBe("interrupted");
    expect(ended.success).toBe(false);
    expect(ended.result).toBe("user abort");
  });

  it("ignores rows outside the round/observation contract (only the lifecycle close remains)", () => {
    const noise = row({
      id: "user-1",
      seq: 1,
      role: "user",
      content_parts: [{ type: "text", text: "查天气" }],
      metadata: { ...runMeta },
    });
    const envelopes = synthesizeExecutionEnvelopes([noise], { sessionId: "session-1", runId: "run-1" });
    expect(envelopes.map((env) => env.type)).toEqual(["agent_started", "agent_ended"]);
    expect((envelopes[1]!.payload as Record<string, unknown>).status).toBe("succeeded");
  });
});
