import { describe, expect, it } from "vitest";

import { selectCompressibleSegment } from "../src/services/agent/context-compression/compression-service.js";
import type { MessageInfo } from "../src/contracts/session/session.js";

/**
 * 对齐用例用 preserveMinTokens=1 / preserveMaxTokens=1 复现"固定 6 条"的旧边界位置,
 * 隔离 token 预算与 user 锚点两个新行为;新行为由专属用例覆盖。
 */
const SETTINGS = {
  compressionTriggerRatio: 0.85,
  summarizeMaxTokens: 300,
  preserveRecentTurns: 3,
  preserveMinTokens: 1,
  preserveMaxTokens: 1,
};

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

/** 约 105 tokens 的 ASCII 内容（400 字符 / 4 + framing）。 */
function bigMsg(role: MessageInfo["role"], extra: Partial<MessageInfo> = {}): MessageInfo {
  return msg(role, { content: "x".repeat(400), ...extra });
}

function toolCall(id: string) {
  return { id, type: "function" as const, function: { name: "grep", arguments: "{}" } };
}

describe("selectCompressibleSegment 配对边界对齐", () => {
  it("保留区不得以 tool 消息开头:切割点落在 tool 结果中间时,整串事务拉进保留区", () => {
    seqCounter = 0;
    // 复刻 session 8be9d5a1 的失败现场:旧历史 + intent(tool_calls) + 4 条 tool + final,
    // preserveRecentTurns=3 → 6 条,初始切割点恰好落在 4 条 tool 中间。
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
    // 共 10 条,初始 boundary=4(保留区从 tool a0 开始,孤儿!)
    const selected = selectCompressibleSegment(history, SETTINGS);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    // 对齐后 boundary=2:段=[user, assistant],保留区从带 tool_calls 的 assistant 开始
    expect(selected.segment.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(selected.replacesUpToSeq).toBe(2);
  });

  it("段尾 assistant tool_use 的结果在保留区时,同样拉回整个事务", () => {
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
    const selected = selectCompressibleSegment(history, SETTINGS);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const kept = history.filter((m) => m.seq > selected.replacesUpToSeq);
    expect(kept[0]?.role === "tool").toBe(false);
  });

  it("切割点恰好在 tool 结果上时回收到其 assistant,保留区不少于条数下限", () => {
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
    // 共 8 条,初始 boundary=2(首条保留消息 tool c0)→ 回收到 1(assistant tool_calls 进保留区)
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

describe("selectCompressibleSegment 保留区 token 预算", () => {
  const BUDGET_SETTINGS = { ...SETTINGS, preserveMinTokens: 800, preserveMaxTokens: 100000 };

  it("保留区估算 token 低于下限时继续向前扩展,不止 preserveRecentTurns×2 条", () => {
    seqCounter = 0;
    // 12 条 × 约 105 tokens;minMessages=6(约 630 < 800)→ 扩展到 8 条(约 840 ≥ 800)。
    // user 放在 idx4 使锚点对齐为无操作,隔离断言 token 预算行为。
    const roles: MessageInfo["role"][] = ["user", "assistant", "assistant", "assistant", "user", "assistant", "assistant", "assistant", "assistant", "assistant", "assistant", "assistant"];
    const history = roles.map((role) => bigMsg(role));
    const selected = selectCompressibleSegment(history, BUDGET_SETTINGS);
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.replacesUpToSeq).toBe(4);
    const kept = history.filter((m) => m.seq > selected.replacesUpToSeq);
    expect(kept.length).toBe(8);
  });

  it("保留区 token 上限在条数下限之上生效", () => {
    seqCounter = 0;
    // 每条约 105 tokens;cap=700:保 6 条(约 630)后下一条会破 cap → 停。
    const roles: MessageInfo["role"][] = Array.from({ length: 12 }, (_, i) => (i % 3 === 0 ? "user" : "assistant"));
    const history = roles.map((role) => bigMsg(role));
    const selected = selectCompressibleSegment(history, { ...SETTINGS, preserveMinTokens: 1, preserveMaxTokens: 700 });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const kept = history.filter((m) => m.seq > selected.replacesUpToSeq);
    expect(kept.length).toBeLessThanOrEqual(7);
    expect(kept.length).toBeGreaterThanOrEqual(6);
  });
});

describe("selectCompressibleSegment user 锚点对齐", () => {
  it("预算允许时保留区内收到最近的 user 消息开头", () => {
    seqCounter = 0;
    const history: MessageInfo[] = [
      bigMsg("user"),
      bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"),
      bigMsg("user"),
      bigMsg("assistant", { tool_calls: [toolCall("u0")] }),
      bigMsg("tool", { tool_call_id: "u0" }),
      bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"),
    ];
    // 13 条;minMessages=6 → 初始 boundary=7(assistant tool_calls);预算 cap 很大
    // → user 锚点把边界内收到 idx6 的 user,保留区以 user 开头且事务完整。
    const selected = selectCompressibleSegment(history, { ...SETTINGS, preserveMinTokens: 1, preserveMaxTokens: 100000 });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.replacesUpToSeq).toBe(6);
    const kept = history.filter((m) => m.seq > selected.replacesUpToSeq);
    expect(kept[0]?.role).toBe("user");
  });

  it("内收会导致保留区超过 token 上限时放弃锚点,接受事务边界", () => {
    seqCounter = 0;
    const history: MessageInfo[] = [
      bigMsg("user"),
      bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"),
      bigMsg("assistant"),
      bigMsg("assistant", { tool_calls: [toolCall("v0")] }),
      bigMsg("tool", { tool_call_id: "v0" }),
      bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"), bigMsg("assistant"),
    ];
    // 同上但 idx6 不是 user;cap=700:保留区 6 条约 630,再加一条(105)破 cap → 放弃内收。
    const selected = selectCompressibleSegment(history, { ...SETTINGS, preserveMinTokens: 1, preserveMaxTokens: 700 });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.replacesUpToSeq).toBe(7);
  });
});
