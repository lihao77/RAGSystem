import { describe, expect, it } from "vitest";

import type { SessionRuntimePayload } from "../src/contracts/events.js";
import { resolveSessionReplayPlan } from "../src/routes/agent/ws.js";

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
        : loadStrategy === "present_interactions"
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

  it.each(["attach_run", "attach_run_and_present_interactions", "attach_resume"] as const)(
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
});
