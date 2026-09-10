import { describe, expect, it, vi } from "vitest";
import type { MessageInfo, SessionMessageListSnapshot } from "../src/contracts/session/session.js";
import { getExecutionCarrierIds, groupExecutionRowsByBoundary } from "../src/services/sessions/execution-boundaries.js";

function row(id: string, seq: number, overrides: Partial<MessageInfo> = {}): MessageInfo {
  return {
    id, seq, session_id: "session-1", role: "user", content_parts: [],
    metadata: { run_id: "run-1" }, created_at: "2026-09-10T00:00:00.000Z",
    thread_key: "root", child_agent_id: null, ...overrides,
  };
}

function page(items: MessageInfo[], hasMore = false): SessionMessageListSnapshot {
  return { items, total: items.length, limit: 1000, offset: 0, has_more: hasMore, outbox_watermark: 0 };
}

const toolCalls: MessageInfo["tool_calls"] = [
  { id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
];

describe("execution boundary availability", () => {
  it.each(["explicit", "legacy", "mixed"])("keeps consecutive empty inputs bare for %s history", async (shape) => {
    const users = [row("u1", 1), row("u2", 2), row("u3", 4), row("u4", 5)];
    // u3 is an older consumed input without metadata.run_id.
    users[2]!.metadata = { consumed_by_run_id: "run-1" };
    const rows = [
      ...users,
      row("tool-round", 3, { role: "assistant", tool_calls: toolCalls,
        metadata: { run_id: "run-1", ...(shape !== "legacy" ? { boundary_message_id: "u2" } : {}) } }),
      row("thinking", 6, { role: "assistant",
        content_parts: [{ type: "thinking", text: "继续检查", round: 2, complete: true }],
        metadata: { run_id: "run-1", ...(shape === "explicit" ? { boundary_message_id: "u4" } : {}) } }),
    ];
    const ids = await getExecutionCarrierIds(users, async () => page(rows.reverse()));
    expect([...ids]).toEqual(["u2", "u4"]);
    const segments = groupExecutionRowsByBoundary(rows);
    expect(segments.get("u2")?.map((item) => item.id)).toContain("tool-round");
    expect(segments.get("u4")?.map((item) => item.id)).toContain("thinking");
  });

  it("honors an explicit earlier boundary for a delayed tool result across input and storage pages", async () => {
    const first = row("u1", 1);
    const next = row("u2", 2);
    const otherRun = row("other-user", 3, { metadata: { run_id: "run-2" } });
    const delayed = row("result", 4, { role: "tool", tool_call_id: "call-1",
      metadata: { run_id: "run-1", msg_type: "observation", boundary_message_id: "u1" } });
    const otherStep = row("other-step", 5, { role: "assistant", tool_calls: toolCalls, metadata: { run_id: "run-2" } });
    const loadPage = vi.fn()
      .mockResolvedValueOnce(page([first, next, otherRun], true))
      .mockResolvedValueOnce(page([delayed, otherStep]));
    // The visible page can contain only the first boundary; its steps live beyond that page.
    expect([...await getExecutionCarrierIds([first, next], loadPage)]).toEqual(["u1"]);
    expect(loadPage.mock.calls).toEqual([[1000, 0, ["run-1"]], [1000, 3, ["run-1"]]]);
  });

  it("does not advertise final text, discarded history, unconsumed inputs, or assistant carriers", async () => {
    const user = row("plain-user", 1);
    const final = row("final", 2, { role: "assistant", content_parts: [{ type: "text", text: "你好" }] });
    const discarded = row("discarded", 3, { metadata: { run_id: "run-1", execution_history_discarded: true } });
    const step = row("discarded-step", 4, { role: "assistant", tool_calls: toolCalls });
    const unconsumed = row("pending", 5, { metadata: {} });
    expect([...await getExecutionCarrierIds([user, final, discarded, unconsumed], async () => page([
      user, final, discarded, step, unconsumed,
    ]))]).toEqual([]);
    const loadPage = vi.fn();
    expect([...await getExecutionCarrierIds([final, discarded, unconsumed], loadPage)]).toEqual([]);
    expect(loadPage).not.toHaveBeenCalled();
  });
});
