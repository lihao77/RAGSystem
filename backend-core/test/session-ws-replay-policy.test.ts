import { describe, expect, it } from "vitest";

import type { SessionRuntimePayload } from "../src/contracts/events.js";
import { resolveSessionReplayPlan, snapshotPresentationEvents } from "../src/routes/agent/ws.js";
import type { Envelope } from "../src/contracts/events.js";

function snapshot(
  loadStrategy: SessionRuntimePayload["load_strategy"],
  active = false,
): SessionRuntimePayload {
  const state = loadStrategy === "attach_run"
    ? "running"
    : loadStrategy === "attach_run_and_present_interactions"
      ? "waiting_interaction"
      : loadStrategy === "attach_resume"
        ? "resuming"
        : loadStrategy === "restore_suspended_run_and_present_interactions"
          ? "suspended"
          : loadStrategy === "watch_maintenance"
            ? "maintenance"
            : "idle";
  return {
    state,
    load_strategy: loadStrategy,
    allowed_actions: [],
    active_run: active
      ? {
          run_id: "run-1",
          status: state as "running" | "waiting_interaction" | "suspended" | "resuming",
          execution_owner: "attached",
          task: "task",
          request_id: "req-1",
          execution_kind: "agent_stream",
          started_at: "2026-07-30T00:00:00.000Z",
          updated_at: "2026-07-30T00:00:00.000Z",
          activity: { models: [], tools: [], updated_at: "2026-07-30T00:00:00.000Z" },
        }
      : null,
    last_run: null,
    pending_interactions: [],
    resume_interaction_id: null,
    maintenance: null,
    observed_at: "2026-07-30T00:00:00.000Z",
  };
}

describe("session websocket replay policy", () => {
  it("首次加载 history 不回放 durable outbox", () => {
    expect(resolveSessionReplayPlan(null, snapshot("history"))).toEqual({
      replayDurable: false,
      replayActive: false,
    });
  });

  it.each([
    "attach_run",
    "attach_run_and_present_interactions",
    "restore_suspended_run_and_present_interactions",
    "attach_resume",
  ] as const)(
    "首次加载 %s 只回放 active run tree",
    (loadStrategy) => {
      expect(resolveSessionReplayPlan(null, snapshot(loadStrategy, true))).toEqual({
        replayDurable: false,
        replayActive: true,
      });
    },
  );

  it("带 cursor 的断线重连执行 durable replay", () => {
    expect(resolveSessionReplayPlan(42, snapshot("history"))).toEqual({
      replayDurable: true,
      replayActive: false,
    });
  });

  it("空历史快照的零水位也执行 durable replay", () => {
    expect(resolveSessionReplayPlan(0, snapshot("history"))).toEqual({
      replayDurable: true,
      replayActive: false,
    });
  });

  it("普通断线重连不重复回放水位前的 active run 展示事件", () => {
    expect(resolveSessionReplayPlan(42, snapshot("attach_run", true))).toEqual({
      replayDurable: true,
      replayActive: false,
    });
  });

  it("历史快照连接同时恢复 active run 展示和水位后的 durable 事件", () => {
    expect(resolveSessionReplayPlan(42, snapshot("attach_run", true), true)).toEqual({
      replayDurable: true,
      replayActive: true,
    });
  });

  it("active run 快照展示回放只取水位内事件并移除 durable seq", () => {
    const events = [
      { type: "tool_call", session_id: "session-1", run_id: "run-1", seq: 40, payload: { tool: "read_file", phase: "start" } },
      { type: "tool_result", session_id: "session-1", run_id: "run-1", seq: 41, payload: { tool: "read_file", phase: "end", ok: true } },
      { type: "stream_output", session_id: "session-1", run_id: "run-1", seq: 43, payload: { phase: "delta", content: "new" } },
    ] as Envelope[];

    const replay = snapshotPresentationEvents(events, 42);

    expect(replay).toHaveLength(2);
    expect(replay.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);
    expect(replay.every((event) => event.seq === undefined)).toBe(true);
  });
});
