import { describe, expect, it, vi } from "vitest";

import { createSessionControl } from "../../src/services/agent/execution/session-control.js";
import { AgentExecutionEventPublisher } from "../../src/services/agent/execution/event-publisher.js";
import { AgentExecutionStatusTracker } from "../../src/services/agent/execution/status-tracker.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { SqliteRuntimeStorage } from "../../src/adapters/local/sqlite-runtime-storage.js";
import { AsyncDurableClientEventPublisher } from "../../src/services/runtime/event-outbox/async-client-event-publisher.js";
import { RuntimeInteractionCoordinator } from "../../src/services/runtime/pending-interaction-service.js";
import { PendingInteractionService } from "../../src/services/runtime/pending-interaction-service.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { createTenantId } from "../../src/identity/types.js";
import { buildExecutionEnvelopeRunStep } from "../../src/services/runtime/event-outbox/execution-envelope-archive.js";

const STATUSES = ["waiting", "suspended", "resolved", "resuming"] as const;

function seedLocal() {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  const sessionId = "stop-parity-local";
  store.createSession(LOCAL_TENANT_ID, sessionId, "usr_local");
  store.createRun({ runId: "root-run", sessionId, status: "suspended", agentName: "root", threadKey: "root" });
  store.createRun({ runId: "child-run", sessionId, status: "suspended", agentName: "child", threadKey: "child:child", parentRunId: "root-run" });
  for (const [index, status] of STATUSES.entries()) {
    const interactionId = `interaction-${status}`;
    store.createPendingInteraction({
      interactionId,
      sessionId,
      runId: index % 2 === 0 ? "root-run" : "child-run",
      rootRunId: "root-run",
      toolCallId: `tool-${status}`,
      batchId: `batch-${status}`,
      kind: "approval",
      requestPayload: { rootCallId: "root-call" },
    });
    if (status !== "waiting") {
      store.updatePendingInteractionStatus({
        sessionId,
        interactionId,
        from: ["waiting"],
        status: status === "resuming" ? "resolved" : status,
        ...(status === "resolved" || status === "resuming" ? { resolution: { approved: true, message: "ok" } } : {}),
      });
    }
    if (status === "resuming") {
      store.updatePendingInteractionStatus({ sessionId, interactionId, from: ["resolved"], status: "resuming" });
    }
  }
  return { store, sessionId };
}

function localControl(store: ReturnType<typeof seedLocal>["store"]) {
  const realtime = new RealtimeEventHub();
  const client = new DurableClientEventPublisher(store, new OutboxDispatcher(store, realtime));
  return createSessionControl({
    statusTracker: new AgentExecutionStatusTracker(),
    eventPublisher: new AgentExecutionEventPublisher(client),
    conversationStore: store,
    pendingInteractions: new PendingInteractionService(client, store),
    executeSynchronously: vi.fn(),
  });
}

function runEndedRecord(sessionId: string, runId: string) {
  const event = {
    type: "run_ended" as const,
    session_id: sessionId,
    run_id: runId,
    payload: { status: "interrupted" as const },
  };
  const eventId = `${runId}:stopped`;
  return {
    step: buildExecutionEnvelopeRunStep(sessionId, runId, event, eventId),
    outbox: {
      sessionId,
      runId,
      eventId,
      eventType: "client.run_ended",
      aggregateType: "run",
      aggregateId: runId,
      payload: { client_event: event },
    },
  };
}

describe("suspended stop Local/SaaS parity", () => {
  it("RuntimeStorage interrupts the whole suspended tree atomically and replays as a no-op", async () => {
    const { store, sessionId } = seedLocal();
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);

    await expect(storage.operations.interruptSession({
      sessionId,
      buildRunEndedRecord: (run) => runEndedRecord(sessionId, run.runId),
    })).resolves.toMatchObject({
      interruptedRuns: [
        { runId: "child-run", parentRunId: "root-run" },
        { runId: "root-run", parentRunId: null },
      ],
      cancelledInteractions: 4,
    });
    expect(store.listRuns(sessionId, 10).items.map((run) => [run.run_id, run.status])).toEqual([
      ["root-run", "interrupted"],
      ["child-run", "interrupted"],
    ]);
    expect(store.listPendingInteractions({ sessionId }).every((item) => item.status === "cancelled")).toBe(true);
    expect(store.listOutboxForReplay({ sessionId }).filter((row) => row.event_type === "client.run_ended")).toHaveLength(1);

    await expect(storage.operations.interruptSession({
      sessionId,
      buildRunEndedRecord: (run) => runEndedRecord(sessionId, run.runId),
    })).resolves.toMatchObject({ interruptedRuns: [], cancelledInteractions: 0, records: [] });
    store.close();
  });

  it("Local cancels every pending state, isolates child terminal events, and is idempotent", async () => {
    const { store, sessionId } = seedLocal();
    const control = localControl(store);

    await expect(control.stopSession(sessionId)).resolves.toBe(true);
    expect(store.listRuns(sessionId, 10).items.map((run) => [run.run_id, run.status])).toEqual([
      ["root-run", "interrupted"],
      ["child-run", "interrupted"],
    ]);
    expect(store.listPendingInteractions({ sessionId }).map((item) => item.status)).toEqual([
      "cancelled", "cancelled", "cancelled", "cancelled",
    ]);
    expect(store.listOutboxForReplay({ sessionId }).filter((row) => row.event_type === "client.run_ended")).toHaveLength(1);
    await expect(control.stopSession(sessionId)).resolves.toBe(false);

    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const publisher = new AsyncDurableClientEventPublisher(storage, { dispatchRows: async () => undefined });
    const coordinator = new RuntimeInteractionCoordinator(storage, publisher);
    await expect(coordinator.respondApprovalAsync(sessionId, "interaction-resolved", { approved: true, message: "replay" }))
      .resolves.toMatchObject({ resolved: false, needsResume: false });
    await expect(storage.operations.claimResume({ sessionId, interactionId: "interaction-resolved", claimId: "replay-claim" }))
      .resolves.toMatchObject({ claimed: false, reason: "terminal" });
    store.close();
  });

  it("SaaS applies the same root/child and pending-state transition", async () => {
    const sessionId = "stop-parity-saas";
    const runs = [
      { run_id: "root-run", parent_run_id: null, status: "suspended" },
      { run_id: "child-run", parent_run_id: "root-run", status: "suspended" },
    ];
    const pending = STATUSES.map((status) => ({ status }));
    const interruptSession = vi.fn().mockImplementation(async () => {
      const interruptedRuns = runs.filter((run) => run.status === "suspended");
      for (const run of interruptedRuns) run.status = "interrupted";
      const active = pending.filter((item) => ["waiting", "suspended", "resolved", "resuming"].includes(item.status));
      for (const item of active) item.status = "cancelled";
      return {
        interruptedRuns: interruptedRuns.map((run) => ({ runId: run.run_id, parentRunId: run.parent_run_id })),
        cancelledInteractions: active.length,
        records: interruptedRuns.filter((run) => run.parent_run_id === null).map((run) => ({ outbox: runEndedRecord(sessionId, run.run_id).outbox })),
      };
    });
    const runtimeStorage = {
      tenantId: createTenantId("tnt_a"),
      operations: { interruptSession },
    };
    const deliver = vi.fn().mockResolvedValue(undefined);
    const pendingPort = { cancelSession: vi.fn() };
    const control = createSessionControl({
      statusTracker: new AgentExecutionStatusTracker(),
      eventPublisher: { publishRunEnded: vi.fn(), publishUserInterrupt: vi.fn() } as never,
      conversationStore: { listRuns: () => ({ items: [] }) } as never,
      pendingInteractions: pendingPort as never,
      runtimeStorage: runtimeStorage as never,
      asyncClientEvents: { deliver },
      executeSynchronously: vi.fn(),
    });

    await expect(control.stopSession(sessionId)).resolves.toBe(true);
    expect(runs.map((run) => [run.run_id, run.status])).toEqual([
      ["root-run", "interrupted"],
      ["child-run", "interrupted"],
    ]);
    expect(pending.map((item) => item.status)).toEqual(["cancelled", "cancelled", "cancelled", "cancelled"]);
    expect(deliver).toHaveBeenCalledTimes(1);
    await expect(control.stopSession(sessionId)).resolves.toBe(false);
    expect(interruptSession).toHaveBeenCalledTimes(2);
  });
});
