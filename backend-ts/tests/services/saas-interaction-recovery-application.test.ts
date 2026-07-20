import { describe, expect, it, vi } from "vitest";

import { createTenantId } from "../../src/identity/types.js";
import { SaaSInteractionRecoveryApplication } from "../../src/adapters/saas/application/interaction/saas-interaction-recovery-application.js";
import type { PendingInteractionRecord } from "../../src/contracts/conversation-store/index.js";

const tenantId = createTenantId("tnt_one");

function pendingRecord(overrides: Partial<PendingInteractionRecord> = {}): PendingInteractionRecord {
  return {
    interaction_id: "interaction-1",
    session_id: "session-1",
    run_id: "run-1",
    root_run_id: "run-1",
    tool_call_id: "tool-1",
    batch_id: "batch-1",
    kind: "approval",
    status: "suspended",
    request_payload: {},
    resolution_payload: null,
    resume_claim_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    responded_at: null,
    consumed_at: null,
    ...overrides,
  };
}

function fixture(record: PendingInteractionRecord | null, unresolved: PendingInteractionRecord[] = []) {
  const conversations = { getSession: vi.fn().mockResolvedValue({ tenant_id: tenantId }) };
  const pending = {
    getPendingInteraction: vi.fn().mockResolvedValue(record),
    listPendingInteractions: vi.fn().mockResolvedValue(unresolved),
    updatePendingInteractionStatus: vi.fn().mockResolvedValue(true),
  };
  const continuations = { getProviderContinuation: vi.fn().mockResolvedValue(null) };
  return {
    app: new SaaSInteractionRecoveryApplication(tenantId, conversations as never, pending as never, continuations as never),
    conversations,
    pending,
    continuations,
  };
}

describe("SaaSInteractionRecoveryApplication", () => {
  it("resolves a suspended approval and marks the completed batch resumable", async () => {
    const record = pendingRecord();
    const { app, pending } = fixture(record);

    await expect(app.respondApproval("session-1", "interaction-1", {
      approved: true,
      message: "continue",
    })).resolves.toMatchObject({
      resolved: true,
      needsResume: true,
      kind: "approval",
      rootRunId: "run-1",
      toolCallId: "tool-1",
    });
    expect(pending.updatePendingInteractionStatus).toHaveBeenCalledWith({
      sessionId: "session-1",
      interactionId: "interaction-1",
      from: ["waiting", "suspended"],
      status: "resolved",
      resolution: { approved: true, message: "continue" },
    });
  });

  it("does not resume until every suspended interaction in the batch is resolved", async () => {
    const record = pendingRecord();
    const { app } = fixture(record, [pendingRecord({ interaction_id: "interaction-2" })]);
    await expect(app.respondApproval("session-1", "interaction-1", {
      approved: true,
      message: "",
    })).resolves.toMatchObject({ resolved: true, needsResume: false });
  });

  it("rejects interactions and continuations outside the bound tenant", async () => {
    const { app, conversations, pending, continuations } = fixture(pendingRecord());
    conversations.getSession.mockResolvedValue({ tenant_id: createTenantId("tnt_other") });

    await expect(app.respondUserInput("session-1", "interaction-1", { value: "answer" }))
      .resolves.toMatchObject({ resolved: false, needsResume: false });
    await expect(app.getProviderContinuation("session-1", "message-1")).resolves.toBeNull();
    expect(pending.getPendingInteraction).not.toHaveBeenCalled();
    expect(continuations.getProviderContinuation).not.toHaveBeenCalled();
  });
});
