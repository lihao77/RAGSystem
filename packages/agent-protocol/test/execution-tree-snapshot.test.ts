import { describe, expect, it } from "vitest";

import { applyEnvelope, createExecutionTreeState, getExecutionTree } from "../src/execution-tree.js";
import { ProtocolEnvelopeSchema } from "../src/protocol.js";

const frame = (payload: Record<string, unknown>) => ({
  type: "stream_output" as const,
  session_id: "s-1",
  run_id: "r-1",
  call_id: "call-root",
  agent_id: "tester",
  payload,
});

describe("execution tree snapshot projection（在飞轮全量取像）", () => {
  it("快照覆盖（非追加）当前轮的思考与正文，后续 delta 继续追加", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, frame({ phase: "reasoning_delta", content: "半截思", round: 0 }) as never);
    applyEnvelope(state, frame({ phase: "delta", content: "半截正", part_index: 0 }) as never);
    // 重连恢复场景：回放只到检查点，快照携带此刻全文整体落位。
    applyEnvelope(state, frame({ phase: "snapshot", round: 0, reasoning: "半截思考", content: "半截正文" }) as never);
    let round = getExecutionTree(state).root.rounds[0]!;
    expect(round.reasoning).toBe("半截思考");
    expect(round.reasoningComplete).toBe(false);
    expect(round.text).toBe("半截正文");

    applyEnvelope(state, frame({ phase: "delta", content: "续", part_index: 0 }) as never);
    round = getExecutionTree(state).root.rounds[0]!;
    expect(round.text).toBe("半截正文续");
  });

  it("快照携带 reasoning_complete 时置位思考封口", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, frame({ phase: "snapshot", round: 0, reasoning: "完整思考", reasoning_complete: true, content: "正文" }) as never);
    const round = getExecutionTree(state).root.rounds[0]!;
    expect(round.reasoning).toBe("完整思考");
    expect(round.reasoningComplete).toBe(true);
  });

  it("快照与 delta 对 agent.output 的语义对齐（覆盖 = 全部 delta 之和）", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, frame({ phase: "delta", content: "a", part_index: 0 }) as never);
    applyEnvelope(state, frame({ phase: "delta", content: "b", part_index: 0 }) as never);
    applyEnvelope(state, frame({ phase: "snapshot", round: 0, content: "ab" }) as never);
    const root = getExecutionTree(state).root;
    expect(root.output).toBe("ab");
    expect(root.rounds[0]!.text).toBe("ab");
  });

  it("snapshot envelope 通过 zod 协议校验（phase 枚举与载荷放行）", () => {
    const parsed = ProtocolEnvelopeSchema.safeParse(frame({
      phase: "snapshot",
      round: 1,
      reasoning: "思考全文",
      reasoning_complete: true,
      content: "正文全文",
    }));
    expect(parsed.success).toBe(true);
  });

  it("陈旧快照写回已完成轮，不产生幻影新轮（intent 展示优先于 text）", () => {
    // 工具执行窗口重连场景：round 0 的文本已随 intent_complete 毕业，迟到快照
    // 必须落回 round 0 而不是新建 round 1——否则同一段文本渲染两次。
    const state = createExecutionTreeState();
    applyEnvelope(state, frame({ phase: "intent_complete", content: "整轮全文", round: 0 }) as never);
    applyEnvelope(state, frame({ phase: "snapshot", round: 0, content: "整轮全文" }) as never);
    const root = getExecutionTree(state).root;
    expect(root.rounds).toHaveLength(1);
    expect(root.rounds[0]!.intent).toBe("整轮全文");
    expect(root.rounds[0]!.intentComplete).toBe(true);
    expect(root.rounds[0]!.text).toBe("整轮全文");
  });

  it("快照重建跨轮 agent.output（已完成轮 intent 之和 + 当轮全文）", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, frame({ phase: "intent_complete", content: "第一轮说明", round: 0 }) as never);
    applyEnvelope(state, frame({ phase: "delta", content: "第二轮半截", part_index: 0 }) as never);
    applyEnvelope(state, frame({ phase: "snapshot", round: 1, content: "第二轮半截" }) as never);
    const root = getExecutionTree(state).root;
    expect(root.output).toBe("第一轮说明第二轮半截");
  });

  it("多 part 流：快照重建单 text part，丢弃重复文本 part、保留 file_ref", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, frame({ phase: "delta", content: "前文", part_index: 0 }) as never);
    applyEnvelope(state, frame({
      phase: "part_added",
      part_index: 1,
      part: { type: "file_ref", file_path: "/a.png", presentation: "inline" },
    }) as never);
    applyEnvelope(state, frame({ phase: "delta", content: "后文", part_index: 2 }) as never);
    // partialRound 是扁平文本累加（"前文后文"）：重建后 text2 的陈旧 part 不得残留。
    applyEnvelope(state, frame({ phase: "snapshot", round: 0, content: "前文后文" }) as never);
    const round = getExecutionTree(state).root.rounds[0]!;
    expect(round.text).toBe("前文后文");
    expect(round.textParts).toEqual([
      { type: "text", text: "前文后文" },
      { type: "file_ref", file_path: "/a.png", presentation: "inline" },
    ]);
  });

  it("textComplete 轮不被迟到快照复活（final 已落地）", () => {
    const state = createExecutionTreeState();
    applyEnvelope(state, frame({ phase: "final", content: "最终答案" }) as never);
    const before = getExecutionTree(state).root.rounds[0]!;
    expect(before.textComplete).toBe(true);
    // 迟到快照带着 round 0 之外的旧文本：final 后 ensureRound(0).textComplete → 跳过正文覆盖。
    applyEnvelope(state, frame({ phase: "snapshot", round: 0, content: "陈旧文本" }) as never);
    expect(getExecutionTree(state).root.rounds[0]!.textComplete).toBe(true);
  });
});
