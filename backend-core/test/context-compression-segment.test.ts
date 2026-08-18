import { describe, expect, it } from "vitest";

import { selectCompressibleSegment } from "../src/services/agent/context-compression/compression-service.js";
import type { MessageInfo } from "../src/contracts/session/session.js";

const SETTINGS = { compressionTriggerRatio: 0.85, summarizeMaxTokens: 300, preserveRecentTurns: 3 };

let seqCounter = 0;
function msg(role: MessageInfo["role"], extra: Partial<MessageInfo> = {}): MessageInfo {
  seqCounter += 1;
  return {
    id: `m${seqCounter}`,
    seq: seqCounter,
    session_id: "s",
    role,
    content: `${role}-${seqCounter}`,
    content_parts: [],
    metadata: {},
    created_at: "",
    thread_key: "root",
    child_agent_id: null,
    ...extra,
  };
}

function toolCall(id: string) {
  return { id, type: "function" as const, function: { name: "grep", arguments: "{}" } };
}

describe("selectCompressibleSegment 配对边界对齐", () => {
  it("保留区不得以 tool 消息开头:切割点落在 tool 结果中间时,整串事务拉进保留区", () => {
    seqCounter = 0;
    // 复刻 session 8be9d5a1 的失败现场:旧历史 + intent(tool_calls) + 4 条 tool + final,
    // preserveRecentTurns=3 → preserveCount=6,初始切割点恰好落在 4 条 tool 中间。
    const history: MessageInfo[] = [
      msg("user"),
      msg("assistant"),
      msg("assistant", { tool_calls: [toolCall("a0"), toolCall("a1"), toolCall("a2"), toolCall("a3")] }),
      msg("tool", { tool_call_id: "a0" }),
      msg("tool", { tool_call_id: "a1" }),
      msg("tool", { tool_call_id: "a2" }),
      msg("tool", { tool_call_id: "a3" }),
      msg("assistant"), // final
      msg("user"),
      msg("assistant"),
    ];
    // 共 10 条,preserveCount=6 → 初始 boundary=4(保留区从 tool a0 开始,孤儿!)
    const selected = selectCompressibleSegment(history, SETTINGS);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    // 对齐后 boundary=2:段=[user, assistant],保留区从带 tool_calls 的 assistant 开始
    expect(selected.segment.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(selected.replacesUpToSeq).toBe(2);
  });

  it("段尾是 assistant tool_use 且其结果在保留区时,同样拉回整个事务", () => {
    seqCounter = 0;
    const history: MessageInfo[] = [
      msg("user"),
      msg("assistant"),
      msg("assistant", { tool_calls: [toolCall("b0")] }),
      msg("tool", { tool_call_id: "b0" }),
      msg("assistant"),
      msg("user"),
      msg("assistant"),
    ];
    // 共 7 条,preserveCount=6 → 初始 boundary=1... 直接落到 tool 场景已由上一用例覆盖;
    // 本用例验证 boundary=2(段尾 assistant tool_use)也能对齐:保留区首条是 tool? 否,是 assistant tool_use 本身。
    const selected = selectCompressibleSegment(history, { ...SETTINGS, preserveRecentTurns: 3 });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const kept = history.filter((m) => m.seq > selected.replacesUpToSeq);
    expect(kept[0]?.role === "tool").toBe(false);
  });

  it("保留区自然以 user 开头时不做多余收缩", () => {
    seqCounter = 0;
    const history: MessageInfo[] = [
      msg("user"),
      msg("assistant", { tool_calls: [toolCall("c0")] }),
      msg("tool", { tool_call_id: "c0" }),
      msg("assistant"),
      msg("user"),
      msg("assistant"),
      msg("user"),
      msg("assistant"),
    ];
    // 共 8 条,preserveCount=6 → boundary=2。首条保留消息是 tool c0? 是 → 回移到 1(assistant tool_calls 进保留区)。
    // 验证结果:段内不含任何不完整事务,保留区首条不是 tool。
    const selected = selectCompressibleSegment(history, SETTINGS);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const kept = history.filter((m) => m.seq > selected.replacesUpToSeq);
    expect(kept.length).toBeGreaterThanOrEqual(6);
    expect(kept[0]?.role).not.toBe("tool");
  });

  it("候选数不足时跳过(insufficient_candidates)", () => {
    seqCounter = 0;
    const history: MessageInfo[] = [msg("user"), msg("assistant")];
    const selected = selectCompressibleSegment(history, SETTINGS);
    expect(selected.ok).toBe(false);
    if (selected.ok) return;
    expect(selected.reason).toBe("insufficient_candidates");
  });
});
