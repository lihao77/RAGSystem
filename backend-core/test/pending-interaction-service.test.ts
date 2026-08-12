import { describe, expect, it, vi } from "vitest";

import { RuntimeInteractionCoordinator } from "../src/services/runtime/pending-interaction-service.js";

describe("RuntimeInteractionCoordinator resume election", () => {
  it("checks durable claim before resolving a live waiter on a running root", async () => {
    const interactionRecord = {
      interaction_id: "interaction-1",
      session_id: "session-1",
      run_id: "run-1",
      root_run_id: "run-1",
      tool_call_id: "tool-1",
      batch_id: "run-1:tool-1",
      kind: "approval",
      status: "waiting",
      request_payload: {},
      resolution_payload: null,
      resume_claim_id: null,
      resume_claim_expires_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      responded_at: null,
      consumed_at: null,
    };
    const runtimeRecord = {
      step: null,
      outbox: {
        id: 1,
        event_id: "event-1",
        tenant_id: "tenant-1",
        session_id: "session-1",
        run_id: "run-1",
        event_type: "client.interaction",
        aggregate_type: "run",
        aggregate_id: "run-1",
        session_seq: 1,
        payload: {},
        status: "pending",
        attempt_count: 0,
        available_at: new Date(0).toISOString(),
        claimed_at: null,
        claimed_by: null,
        published_at: null,
        last_error: null,
        created_at: new Date(0).toISOString(),
      },
    };
    const recordInteraction = vi.fn(async (input: { interaction: { interactionId: string } }) => ({
      interaction: {
        ...interactionRecord,
        interaction_id: input.interaction.interactionId,
      },
      record: runtimeRecord,
    }));
    const resolveInteraction = vi.fn(async (input: { interactionId: string }) => ({
      interaction: {
        ...interactionRecord,
        interaction_id: input.interactionId,
        status: "resolved",
        resolution_payload: { kind: "approval", approved: true, message: "ok" },
      },
      previousStatus: "waiting",
      changed: true,
      batchReady: true,
      rootRunStatus: "running",
      record: runtimeRecord,
    }));
    let releaseClaim!: () => void;
    const claimResume = vi.fn(() => new Promise<{ claimed: false; reason: "root_not_suspended" }>((resolve) => {
      releaseClaim = () => resolve({ claimed: false, reason: "root_not_suspended" });
    }));
    const startClaim = vi.fn();
    const coordinator = new RuntimeInteractionCoordinator({
      operations: {
        recordInteraction,
        resolveInteraction,
        recoverExpiredResumeClaims: vi.fn(async () => ({
          recoveredClaimIds: [],
          recoveredBatchIds: [],
          suspendedRootRunIds: [],
        })),
        claimResume,
      },
    } as never, {
      deliver: vi.fn(async () => undefined),
      publish: vi.fn(async () => undefined),
    } as never);
    coordinator.bindResumeStarter({ startClaim });

    let waiterResolved = false;
    const waiter = coordinator.waitForApproval({
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "run-1",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-1",
      deadlineMs: 5_000,
      task: "task",
      toolName: "write_file",
    }).then((value) => {
      waiterResolved = true;
      return value;
    });
    await vi.waitFor(() => expect(recordInteraction).toHaveBeenCalledTimes(1));
    const interactionId = recordInteraction.mock.calls[0]![0].interaction.interactionId;

    const response = coordinator.respondApprovalAsync(
      "session-1",
      interactionId,
      { approved: true, message: "ok" },
    );
    await vi.waitFor(() => expect(claimResume).toHaveBeenCalledTimes(1));
    expect(waiterResolved).toBe(false);
    expect(startClaim).not.toHaveBeenCalled();

    releaseClaim();
    await expect(response).resolves.toEqual(expect.objectContaining({
      resolved: true,
      needsResume: false,
    }));
    await expect(waiter).resolves.toEqual(expect.objectContaining({
      approvalId: interactionId,
      approved: true,
      message: "ok",
    }));
    expect(startClaim).not.toHaveBeenCalled();
  });
});
