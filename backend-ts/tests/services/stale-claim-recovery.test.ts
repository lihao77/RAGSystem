import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { SqliteRuntimeStorage } from "../../src/adapters/local/sqlite-runtime-storage.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { createTenantId } from "../../src/identity/types.js";
import { buildExecutionEnvelopeRunStep } from "../../src/services/runtime/event-outbox/execution-envelope-archive.js";

function setup(status: "running" | "suspended" = "suspended") {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  const sessionId = "claim-session";
  store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: sessionId, ownerUserId: "user-1", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
  store.createRun({ runId: "root-run", sessionId, status, agentName: "root", threadKey: "root" });
  return { store, sessionId, storage: new SqliteRuntimeStorage(LOCAL_TENANT_ID, store) };
}

function interactionRecord(sessionId: string, interactionId: string, runId = "root-run", phase: "required" | "responded" = "required") {
  const event = {
    type: "interaction" as const,
    session_id: sessionId,
    call_id: interactionId,
    run_id: runId,
    payload: phase === "required"
      ? { kind: "approval" as const, phase, input: { tool_call_id: `tool-${interactionId}` } }
      : { kind: "approval" as const, phase, approved: true, message: "ok" },
  };
  const eventId = `${interactionId}:${phase}`;
  return {
    step: buildExecutionEnvelopeRunStep(sessionId, runId, event, eventId),
    outbox: {
      sessionId,
      runId,
      eventId,
      eventType: "client.interaction",
      aggregateType: "run",
      aggregateId: runId,
      payload: { client_event: event },
    },
  };
}

async function addInteraction(
  storage: SqliteRuntimeStorage,
  sessionId: string,
  interactionId: string,
  batchId = interactionId,
) {
  await storage.operations.recordInteraction({
    interaction: {
      interactionId,
      sessionId,
      runId: "root-run",
      rootRunId: "root-run",
      toolCallId: `tool-${interactionId}`,
      batchId,
      kind: "approval",
      requestPayload: { rootCallId: "root-call" },
    },
    rootCallId: "root-call",
    record: interactionRecord(sessionId, interactionId),
  });
}

async function resolve(storage: SqliteRuntimeStorage, sessionId: string, interactionId: string) {
  return storage.operations.resolveInteraction({
    sessionId,
    interactionId,
    resolution: { kind: "approval", approved: true, message: "ok" },
    buildRecord: (interaction) => interactionRecord(sessionId, interaction.interaction_id, interaction.run_id, "responded"),
  });
}

describe("resume claim recovery matrix", () => {
  it("allows one fresh claim, rejects a duplicate, then permits token rollback and retry", async () => {
    const { store, storage, sessionId } = setup();
    await addInteraction(storage, sessionId, "fresh");
    await resolve(storage, sessionId, "fresh");

    await expect(storage.operations.claimResume({ sessionId, interactionId: "fresh", claimId: "claim-1" }))
      .resolves.toMatchObject({ claimed: true, claimId: "claim-1" });
    await expect(storage.operations.claimResume({ sessionId, interactionId: "fresh", claimId: "claim-2" }))
      .resolves.toEqual({ claimed: false, reason: "already_claimed" });
    await expect(storage.operations.rollbackResume({ sessionId, rootRunId: "root-run", claimId: "claim-1" }))
      .resolves.toEqual({ rolledBack: true });
    await expect(storage.operations.claimResume({ sessionId, interactionId: "fresh", claimId: "claim-2" }))
      .resolves.toMatchObject({ claimed: true, claimId: "claim-2" });
    store.close();
  });

  it("distinguishes incomplete batches and terminal interactions", async () => {
    const first = setup();
    await addInteraction(first.storage, first.sessionId, "batch-a", "batch");
    await addInteraction(first.storage, first.sessionId, "batch-b", "batch");
    await resolve(first.storage, first.sessionId, "batch-a");
    await expect(first.storage.operations.claimResume({ sessionId: first.sessionId, interactionId: "batch-a", claimId: "partial" }))
      .resolves.toEqual({ claimed: false, reason: "batch_incomplete" });
    first.store.close();

    const terminal = setup();
    await addInteraction(terminal.storage, terminal.sessionId, "terminal");
    terminal.store.cancelPendingInteractions(terminal.sessionId);
    await expect(terminal.storage.operations.claimResume({ sessionId: terminal.sessionId, interactionId: "terminal", claimId: "terminal-claim" }))
      .resolves.toEqual({ claimed: false, reason: "terminal" });
    terminal.store.close();
  });

  it("serializes stop/resolve races and rejects cross-tenant access", async () => {
    const { store, storage, sessionId } = setup();
    await addInteraction(storage, sessionId, "race");
    await storage.operations.interruptSession({ sessionId, buildRunEndedRecord: () => ({ outbox: { sessionId, runId: "root-run", eventId: "root:stop", eventType: "client.run_ended", aggregateType: "run", aggregateId: "root-run", payload: {} } }) });
    await expect(resolve(storage, sessionId, "race")).rejects.toMatchObject({ reason: "cancelled" });
    await expect(storage.operations.claimResume({ sessionId, interactionId: "race", claimId: "race-claim" }))
      .resolves.toEqual({ claimed: false, reason: "terminal" });

    const foreign = new SqliteRuntimeStorage(createTenantId("tnt_foreign"), store);
    await expect(foreign.operations.claimResume({ sessionId, interactionId: "race", claimId: "foreign-claim" }))
      .rejects.toThrow(/another tenant|tenant/i);
    store.close();
  });

  it("does not interrupt a running root owned by an active runtime", async () => {
    const { store, storage, sessionId } = setup("running");
    await addInteraction(storage, sessionId, "active");

    await expect(storage.operations.interruptSession({
      sessionId,
      buildRunEndedRecord: () => ({
        outbox: {
          sessionId,
          runId: "root-run",
          eventId: "root:stop",
          eventType: "client.run_ended",
          aggregateType: "run",
          aggregateId: "root-run",
          payload: {},
        },
      }),
    })).resolves.toMatchObject({ interruptedRuns: [], cancelledInteractions: 0 });
    expect(store.getRun(sessionId, "root-run")?.status).toBe("running");
    expect(store.getPendingInteraction(sessionId, "active")?.status).toBe("waiting");
    store.close();
  });

  it("keeps a live lease, renews it, and only recovers after durable expiry", async () => {
    const { store, storage, sessionId } = setup();
    await addInteraction(storage, sessionId, "lease");
    await resolve(storage, sessionId, "lease");
    const claimed = await storage.operations.claimResume({
      sessionId,
      interactionId: "lease",
      claimId: "lease-1",
      leaseMs: 50,
    });
    expect(claimed.claimed).toBe(true);

    const beforeExpiry = new Date(Date.now() + 10).toISOString();
    await expect(storage.operations.recoverExpiredResumeClaims({ sessionId, now: beforeExpiry }))
      .resolves.toMatchObject({ recoveredClaimIds: [] });

    const renewed = await storage.operations.renewResumeClaim({
      sessionId,
      rootRunId: "root-run",
      claimId: "lease-1",
      leaseMs: 1000,
    });
    expect(renewed.renewed).toBe(true);
    await expect(storage.operations.recoverExpiredResumeClaims({
      sessionId,
      now: new Date(Date.now() + 100).toISOString(),
    })).resolves.toMatchObject({ recoveredClaimIds: [] });

    await expect(storage.operations.recoverExpiredResumeClaims({
      sessionId,
      now: new Date(Date.now() + 2000).toISOString(),
    })).resolves.toMatchObject({
      recoveredClaimIds: ["lease-1"],
      suspendedRootRunIds: ["root-run"],
    });
    await expect(storage.operations.renewResumeClaim({
      sessionId,
      rootRunId: "root-run",
      claimId: "lease-1",
      leaseMs: 1000,
    })).resolves.toEqual({ renewed: false, expiresAt: null });
    store.close();
  });
});
