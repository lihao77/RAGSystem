import { describe, expect, it, vi } from "vitest";

import { createSessionControl } from "../../src/services/agent/execution/session-control.js";
import { AgentExecutionEventPublisher } from "../../src/services/agent/execution/event-publisher.js";
import { AgentExecutionStatusTracker } from "../../src/services/agent/execution/status-tracker.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { DurableClientEventPublisher } from "../../src/services/runtime/event-outbox/client-event-publisher.js";
import { OutboxDispatcher } from "../../src/services/runtime/event-outbox/dispatcher.js";
import { RuntimeInteractionCoordinator } from "../../src/services/runtime/pending-interaction-service.js";
import { RealtimeEventHub } from "../../src/services/runtime/realtime-event-hub.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { SqliteRuntimeStorage } from "../../src/adapters/local/sqlite-runtime-storage.js";
import { LocalOutboxStoreAdapter } from "../../src/adapters/local/local-outbox-store-adapter.js";

describe("SessionControl", () => {
  it("停止挂起 session 时中断 run 并取消 durable pending", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "session-suspended-stop", ownerUserId: "usr_local", visibility: "private", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
    store.createRun({
      runId: "run-suspended-stop",
      sessionId: "session-suspended-stop",
      status: "suspended",
      taskSummary: "等待审批",
      agentName: "orchestrator_agent",
      threadKey: "root",
    });
    store.createPendingInteraction({
      interactionId: "approval-suspended-stop",
      sessionId: "session-suspended-stop",
      runId: "run-suspended-stop",
      rootRunId: "run-suspended-stop",
      toolCallId: "tool-suspended-stop",
      batchId: "batch-suspended-stop",
      kind: "approval",
      requestPayload: {},
    });
    store.suspendPendingInteractions("session-suspended-stop", "run-suspended-stop");

    const realtimeEvents = new RealtimeEventHub();
    const dispatcher = new OutboxDispatcher(new LocalOutboxStoreAdapter(store), realtimeEvents);
    const runtimeStorage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const clientEvents = new DurableClientEventPublisher(runtimeStorage, {
      dispatchRows: async (rows) => dispatcher.dispatchRows(rows),
    });
    const control = createSessionControl({
      statusTracker: new AgentExecutionStatusTracker(),
      eventPublisher: new AgentExecutionEventPublisher(clientEvents),
      pendingInteractions: new RuntimeInteractionCoordinator(runtimeStorage, clientEvents),
      runtimeStorage,
      clientEvents,
      executeSynchronously: vi.fn(),
    });

    await expect(control.stopSession("session-suspended-stop")).resolves.toBe(true);
    expect(store.getRun("session-suspended-stop", "run-suspended-stop")?.status).toBe("interrupted");
    expect(store.getPendingInteraction("session-suspended-stop", "approval-suspended-stop")?.status).toBe("cancelled");
    expect(realtimeEvents.getHistory("session-suspended-stop")).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run_ended", run_id: "run-suspended-stop" }),
    ]));
    store.close();
  });

  it("SaaS 停止挂起 session 时使用异步持久化端口和 durable outbox", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const interruptSession = vi.fn().mockResolvedValue({
      interruptedRuns: [
        { runId: "run-root", parentRunId: null },
        { runId: "run-child", parentRunId: "run-root" },
      ],
      cancelledInteractions: 2,
      records: [],
    });
    const clientEvents = {
      publish: vi.fn(async () => { throw new Error("publish is not used by suspended stop"); }),
      deliver: vi.fn().mockResolvedValue([]),
    };
    const control = createSessionControl({
      statusTracker: new AgentExecutionStatusTracker(),
      eventPublisher: { publishRunEnded: vi.fn(), publishUserInterrupt: vi.fn() } as never,
      pendingInteractions: { cancelSession: vi.fn().mockResolvedValue(undefined) } as never,
      runtimeStorage: { operations: { interruptSession } } as never,
      clientEvents,
      executeSynchronously: vi.fn(),
    });

    await expect(control.stopSession("session-saas-stop")).resolves.toBe(true);
    expect(interruptSession).toHaveBeenCalledOnce();
    expect(store.listOutbox({ limit: 10 }).items).toHaveLength(0);
    store.close();
  });
});
