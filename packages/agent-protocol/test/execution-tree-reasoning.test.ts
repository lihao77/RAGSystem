import { describe, expect, it } from "vitest";

import { applyEnvelope, createExecutionTreeState, getExecutionTree } from "../src/execution-tree.js";
import { ProtocolEnvelopeSchema } from "../src/protocol.js";

const envelope = (phase: string, content: string, round: number) => ({
  type: "stream_output" as const,
  session_id: "s-1",
  run_id: "r-1",
  call_id: "call-root",
  agent_id: "tester",
  payload: { phase, content, round },
});

describe("execution tree reasoning projection", () => {
  it("delta 累加，complete 覆盖全文并置位", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, envelope("reasoning_delta", "think ", 0) as never);
    applyEnvelope(state, envelope("reasoning_delta", "twice", 0) as never);
    let round = getExecutionTree(state).root.rounds[0]!;
    expect(round.reasoning).toBe("think twice");
    expect(round.reasoningComplete).toBe(false);

    applyEnvelope(state, envelope("reasoning_complete", "think twice (final)", 0) as never);
    round = getExecutionTree(state).root.rounds[0]!;
    expect(round.reasoning).toBe("think twice (final)");
    expect(round.reasoningComplete).toBe(true);
    // durable 全文已封口，迟到的增量不能倒灌。
    applyEnvelope(state, envelope("reasoning_delta", "straggler", 0) as never);
    round = getExecutionTree(state).root.rounds[0]!;
    expect(round.reasoning).toBe("think twice (final)");
  });

  it("reasoning 与 intent 同轮共存、多轮独立", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, envelope("reasoning_complete", "first thought", 0) as never);
    applyEnvelope(state, envelope("intent_complete", "first action", 0) as never);
    applyEnvelope(state, envelope("reasoning_complete", "second thought", 1) as never);
    applyEnvelope(state, envelope("intent_complete", "second action", 1) as never);

    expect(getExecutionTree(state).root.rounds.map((r) => ({
      reasoning: r.reasoning,
      reasoningComplete: r.reasoningComplete,
      intent: r.intent,
      intentComplete: r.intentComplete,
    }))).toEqual([
      { reasoning: "first thought", reasoningComplete: true, intent: "first action", intentComplete: true },
      { reasoning: "second thought", reasoningComplete: true, intent: "second action", intentComplete: true },
    ]);
  });

  it("历史回放：仅 reasoning_complete 快照即可重建思考块", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, envelope("reasoning_complete", "archived reasoning", 0) as never);
    const round = getExecutionTree(state).root.rounds[0]!;
    expect(round.reasoning).toBe("archived reasoning");
    expect(round.reasoningComplete).toBe(true);
  });

  it("reasoning envelope 通过 zod 协议校验（phase 枚举放行）", () => {
    const parsed = ProtocolEnvelopeSchema.parse(envelope("reasoning_delta", "ok", 0));
    expect(parsed.type).toBe("stream_output");
    expect(parsed.payload.phase).toBe("reasoning_delta");
  });
});
