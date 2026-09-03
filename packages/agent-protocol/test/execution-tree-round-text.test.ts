import { describe, expect, it } from "vitest";

import { applyEnvelope, createExecutionTreeState, getExecutionTree } from "../src/execution-tree.js";

const outputEnvelope = (phase: string, payload: Record<string, unknown> = {}) => ({
  type: "stream_output" as const,
  session_id: "s-1",
  run_id: "r-1",
  call_id: "call-root",
  agent_id: "tester",
  payload: { phase, ...payload },
});

describe("execution tree round text projection", () => {
  it("delta 流式落活跃轮，final 让位给消息行（轮 text 清空、只出现一次）", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, outputEnvelope("delta", { content: "最终" }) as never);
    applyEnvelope(state, outputEnvelope("delta", { content: "答案" }) as never);
    let round = getExecutionTree(state).root.rounds[0]!;
    expect(round.text).toBe("最终答案");
    expect(round.textComplete).toBe(false);

    // final：答案毕业到消息槽 assistant 行——轮 text 通道让位，不双处呈现。
    applyEnvelope(state, outputEnvelope("final", { content: "最终答案" }) as never);
    const tree = getExecutionTree(state);
    round = tree.root.rounds[0]!;
    expect(round.text).toBe("");
    expect(round.textParts).toBeUndefined();
    expect(round.textComplete).toBe(true);
    // agent.output 保留全文（child agent result_summary 消费方不受影响）。
    expect(tree.root.output).toBe("最终答案");
  });

  it("工具轮说明常驻面板，下一轮正文开新轮", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, outputEnvelope("delta", { content: "查一下" }) as never);
    applyEnvelope(state, {
      type: "stream_output" as const,
      session_id: "s-1",
      run_id: "r-1",
      call_id: "call-root",
      agent_id: "tester",
      payload: { phase: "intent_complete", content: "查一下", round: 0 },
    } as never);
    let rounds = getExecutionTree(state).root.rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.intent).toBe("查一下");
    expect(rounds[0]!.text).toBe("查一下");

    // 上一轮已定格 → 新一轮正文开 round 1（无思考模型靠此规则推断轮次）。
    applyEnvelope(state, outputEnvelope("delta", { content: "总结" }) as never);
    rounds = getExecutionTree(state).root.rounds;
    expect(rounds).toHaveLength(2);
    expect(rounds[1]!.text).toBe("总结");
  });

  it("无任何思考/说明前导时首轮即 round 0", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, outputEnvelope("delta", { content: "直接回答" }) as never);
    const rounds = getExecutionTree(state).root.rounds;
    expect(rounds[0]!.round).toBe(0);
    expect(rounds[0]!.text).toBe("直接回答");
  });

  it("无文字工具轮不吞下一轮正文——说明落新轮，不插到工具行上方", () => {
    const state = createExecutionTreeState();
    // round 0：纯工具轮（无说明文字 → 后端不发 intent_complete，该轮永不定格）。
    applyEnvelope(state, {
      type: "tool_call" as const,
      session_id: "s-1",
      run_id: "r-1",
      call_id: "t-1",
      payload: { tool: "search", input: {}, round: 0, lineage: { parent_call_id: "call-root" } },
    } as never);
    // round 1：说明文字流式（无思考前导，delta 只能靠活跃轮推断归属）。
    applyEnvelope(state, outputEnvelope("delta", { content: "找到了，" }) as never);
    applyEnvelope(state, outputEnvelope("delta", { content: "总结如下" }) as never);
    let rounds = getExecutionTree(state).root.rounds;
    expect(rounds).toHaveLength(2);
    expect(rounds[0]!.text).toBe("");
    expect(rounds[0]!.toolCalls).toHaveLength(1);
    expect(rounds[1]!.round).toBe(1);
    expect(rounds[1]!.text).toBe("找到了，总结如下");

    // 轮末 intent_complete 落在正确轮——工具轮 text 通道没有误入副本，不产生重复。
    applyEnvelope(state, {
      type: "stream_output" as const,
      session_id: "s-1",
      run_id: "r-1",
      call_id: "call-root",
      agent_id: "tester",
      payload: { phase: "intent_complete", content: "找到了，总结如下", round: 1 },
    } as never);
    applyEnvelope(state, {
      type: "tool_call" as const,
      session_id: "s-1",
      run_id: "r-1",
      call_id: "t-2",
      payload: { tool: "search", input: {}, round: 1, lineage: { parent_call_id: "call-root" } },
    } as never);
    rounds = getExecutionTree(state).root.rounds;
    expect(rounds[0]!.intent).toBe("");
    expect(rounds[1]!.intent).toBe("找到了，总结如下");
    expect(rounds[1]!.toolCalls).toHaveLength(1);
  });

  it("乱序落位：小号轮晚到时 rounds 保持轮号有序（视图按数组序渲染）", () => {
    const state = createExecutionTreeState();
    // 边界队列迟冲刷等乱序路径：先见到 round 1，后补 round 0。
    applyEnvelope(state, outputEnvelope("reasoning_delta", { content: "思考B", round: 1 }) as never);
    applyEnvelope(state, outputEnvelope("intent_complete", { content: "查一下", round: 0 }) as never);
    const rounds = getExecutionTree(state).root.rounds;
    expect(rounds.map((r) => r.round)).toEqual([0, 1]);
    expect(rounds[0]!.intent).toBe("查一下");
    expect(rounds[1]!.reasoning).toBe("思考B");
  });
});
