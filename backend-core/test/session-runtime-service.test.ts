import { describe, expect, it } from "vitest";

import type { PendingInteractionRecord, RunInfo } from "../src/contracts/conversation-store/index.js";
import type { SessionInfo } from "../src/contracts/session/session.js";
import type { RuntimeSessionFacts } from "../src/contracts/storage/runtime-storage.js";
import { createTenantId } from "../src/identity/types.js";
import { projectSessionRuntime } from "../src/services/runtime/session-runtime-service.js";

function session(metadata: Record<string, unknown> = {}): SessionInfo {
  return {
    session_id: "session-1",
    tenant_id: createTenantId("tnt_test"),
    owner_user_id: null,
    visibility: "private",
    origin_type: "direct",
    origin_id: null,
    origin_channel: "web",
    workspace_id: null,
    permission_mode: null,
    metadata,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:01.000Z",
  } as SessionInfo;
}

function run(status = "running", overrides: Partial<RunInfo> = {}): RunInfo {
  return {
    run_id: "run-1",
    session_id: "session-1",
    tenant_id: "tnt_test",
    entrypoint: "agent_stream",
    status,
    task_summary: "task",
    request_id: "req-1",
    user_id: null,
    agent_name: "root",
    thread_key: "root",
    parent_run_id: null,
    parent_call_id: null,
    child_agent_id: null,
    final_message_id: null,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:01.000Z",
    ...overrides,
  };
}

function interaction(
  status: PendingInteractionRecord["status"],
  overrides: Partial<PendingInteractionRecord> = {},
): PendingInteractionRecord {
  return {
    interaction_id: "interaction-1",
    session_id: "session-1",
    run_id: "run-1",
    root_run_id: "run-1",
    tool_call_id: "tool-1",
    batch_id: "batch-1",
    kind: "approval",
    status,
    request_payload: {
      interaction_payload: {
        kind: "approval",
        phase: "required",
        tool: "write_file",
        input: { path: "a.txt" },
        message: "允许写入？",
      },
    },
    resolution_payload: status === "resolved" ? { kind: "approval", approved: true, message: "" } : null,
    resume_claim_id: status === "resuming" ? "claim-1" : null,
    resume_claim_expires_at: null,
    created_at: "2026-07-30T00:00:01.000Z",
    updated_at: "2026-07-30T00:00:02.000Z",
    responded_at: status === "resolved" ? "2026-07-30T00:00:02.000Z" : null,
    consumed_at: null,
    ...overrides,
  };
}

function facts(overrides: Partial<RuntimeSessionFacts> = {}): RuntimeSessionFacts {
  return {
    session: session(),
    activeRootRun: null,
    latestTerminalRootRun: null,
    pendingInteractions: [],
    ownedByCurrentInstance: false,
    ...overrides,
  };
}

describe("SessionRuntimeService projection", () => {
  it.each([
    ["idle", "history", facts(), ["send_message", "start_maintenance"]],
    [
      "maintenance",
      "watch_maintenance",
      facts({ session: session({ runtime_maintenance: { kind: "rollback", expires_at: "2999-01-01T00:00:00.000Z" } }) }),
      [],
    ],
    ["running", "attach_run", facts({ activeRootRun: run(), ownedByCurrentInstance: true }), ["send_followup", "stop_run"]],
    [
      "waiting_interaction",
      "attach_run_and_present_interactions",
      facts({ activeRootRun: run(), pendingInteractions: [interaction("waiting")], ownedByCurrentInstance: true }),
      ["respond_interaction", "stop_run"],
    ],
    [
      "suspended",
      "restore_suspended_run_and_present_interactions",
      facts({ activeRootRun: run("suspended"), pendingInteractions: [interaction("suspended")] }),
      ["respond_interaction", "stop_run"],
    ],
    [
      "resuming",
      "attach_resume",
      facts({ activeRootRun: run("suspended"), pendingInteractions: [interaction("resuming")], ownedByCurrentInstance: true }),
      ["stop_run"],
    ],
  ])("projects %s with %s", (state, loadStrategy, input, actions) => {
    const snapshot = projectSessionRuntime(input);
    expect(snapshot.state).toBe(state);
    expect(snapshot.load_strategy).toBe(loadStrategy);
    expect(snapshot.allowed_actions).toEqual(actions);
  });

  it("does not advertise in-memory actions for a remote running or waiting owner", () => {
    expect(projectSessionRuntime(facts({
      activeRootRun: run(),
      ownedByCurrentInstance: false,
    })).allowed_actions).toEqual([]);
    expect(projectSessionRuntime(facts({
      activeRootRun: run(),
      pendingInteractions: [interaction("waiting")],
      ownedByCurrentInstance: false,
    })).allowed_actions).toEqual([]);
  });

  it("turns a resolved suspended interaction into resume_run without presenting it again", () => {
    const snapshot = projectSessionRuntime(facts({
      activeRootRun: run("suspended"),
      pendingInteractions: [interaction("resolved")],
    }));

    expect(snapshot.state).toBe("suspended");
    expect(snapshot.pending_interactions).toEqual([]);
    expect(snapshot.resume_interaction_id).toBe("interaction-1");
    expect(snapshot.allowed_actions).toEqual(["resume_run", "stop_run"]);
  });

  it("keeps the latest terminal outcome in last_run while an active run is projected", () => {
    const snapshot = projectSessionRuntime(facts({
      activeRootRun: run("running", { run_id: "run-active" }),
      latestTerminalRootRun: run("failed", {
        run_id: "run-failed",
        updated_at: "2026-07-29T23:59:59.000Z",
      }),
      ownedByCurrentInstance: true,
    }));

    expect(snapshot.state).toBe("running");
    expect(snapshot.active_run?.run_id).toBe("run-active");
    expect(snapshot.last_run).toEqual(expect.objectContaining({ run_id: "run-failed", status: "failed" }));
  });
});
