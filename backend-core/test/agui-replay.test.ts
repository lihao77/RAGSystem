import { describe, expect, it } from "vitest";

import type { OutboxRow } from "../src/contracts/conversation-store/index.js";
import type { ExecutionReadApplication } from "../src/contracts/execution/execution-read-application.js";
import { loadAguiRunReplay } from "../src/services/agui-gateway/agui-replay.js";

function row(seq: number, type: string, payload: Record<string, unknown> = {}): OutboxRow {
  return {
    id: seq,
    event_id: `event-${seq}`,
    session_id: "session-1",
    tenant_id: "tenant-1",
    run_id: "run-1",
    session_seq: seq,
    event_type: `client.${type}`,
    aggregate_type: "session",
    aggregate_id: "session-1",
    payload: JSON.stringify({
      client_event: { type, session_id: "session-1", run_id: "run-1", payload },
    }),
    status: "delivered",
    attempts: 0,
    available_at: null,
    locked_at: null,
    delivered_at: "2026-07-30T00:00:00.000Z",
    last_error: null,
    created_at: "2026-07-30T00:00:00.000Z",
  };
}

describe("AG-UI active run replay", () => {
  it("replays presentation events after the cursor without repeating old interactions or delegates", async () => {
    const rows = [
      row(10, "stream_output", { phase: "delta", content: "已输出" }),
      row(11, "interaction", { phase: "required", kind: "approval" }),
      row(12, "delegate_call", { tool: "client_tool" }),
      row(13, "stream_output", { phase: "delta", content: "继续输出" }),
    ];
    const reads = {
      listOutboxForReplay: async ({ afterSeq = 0 }: { afterSeq?: number | null }) => rows.filter((item) => item.session_seq > (afterSeq ?? 0)),
    } as unknown as ExecutionReadApplication;

    const events = await loadAguiRunReplay(reads, "session-1", "run-1", 10);

    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [13, "stream_output"],
    ]);
  });
});
