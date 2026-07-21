import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { RecoverableInterrupt } from "@ragsystem/agent-protocol";

import { SqliteRuntimeStorage } from "../../src/adapters/local/sqlite-runtime-storage.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import type { ConversationStore } from "../../src/contracts/conversation-store/index.js";
import type { InteractionResumeStarter } from "../../src/contracts/runtime/pending-interactions.js";
import type { RuntimeFinalizeStatus, RuntimeStorage } from "../../src/contracts/storage/runtime-storage.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { AsyncDurableClientEventPublisher } from "../../src/services/runtime/event-outbox/async-client-event-publisher.js";
import { RuntimeInteractionCoordinator } from "../../src/services/runtime/pending-interaction-service.js";
import { makeTempRoot } from "../helpers/temp-db.js";

const stores = new Set<ConversationStore>();

afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

function createStore(dbPath = ":memory:", dataRoot = process.cwd()) {
  const store = createConversationStore({ dbPath, dataRoot });
  stores.add(store);
  return store;
}

function closeStore(store: ConversationStore) {
  store.close();
  stores.delete(store);
}

function seedRoot(store: ConversationStore, sessionId = "session-1", runId = "run-1") {
  store.createSession(LOCAL_TENANT_ID, sessionId, "usr_local", { source: "coordinator-test" });
  store.createRun({
    runId,
    sessionId,
    status: "running",
    taskSummary: "approve",
    requestId: "request-1",
    userId: "usr_local",
    agentName: "orchestrator_agent",
    threadKey: "root",
    entrypoint: "agent_stream",
  });
}

function createCoordinator(storage: RuntimeStorage, startClaim?: InteractionResumeStarter["startClaim"]) {
  const dispatchRows = vi.fn(async () => []);
  const coordinator = new RuntimeInteractionCoordinator(
    storage,
    new AsyncDurableClientEventPublisher(storage, { dispatchRows }),
  );
  if (startClaim) coordinator.bindResumeStarter({ startClaim });
  return { coordinator, dispatchRows };
}

async function recordTimedOutApproval(
  coordinator: RuntimeInteractionCoordinator,
  input: {
    sessionId?: string;
    runId?: string;
    rootRunId?: string;
    toolCallId: string;
    batchId?: string;
  },
) {
  let interactionId = "";
  const waiting = coordinator.waitForApproval({
    sessionId: input.sessionId ?? "session-1",
    runId: input.runId ?? "run-1",
    rootRunId: input.rootRunId ?? "run-1",
    parentRunId: null,
    parentCallId: null,
    rootCallId: "root-call-1",
    requestId: "request-1",
    toolCallId: input.toolCallId,
    interactionBatchId: input.batchId,
    deadlineMs: 0,
    task: "approve",
    executionKind: "agent_stream",
    toolName: "execute_bash",
    onInteractionRequired: (notice) => { interactionId = notice.interactionId; },
  });
  await expect(waiting).rejects.toBeInstanceOf(RecoverableInterrupt);
  expect(interactionId).not.toBe("");
  return interactionId;
}

async function finalizeRoot(
  storage: RuntimeStorage,
  status: RuntimeFinalizeStatus,
  sessionId = "session-1",
  runId = "run-1",
) {
  return storage.operations.finalizeRun({
    runId,
    sessionId,
    status,
    interactionRootRunId: runId,
    ...(status === "completed" ? {
      finalMessage: {
        messageId: `${runId}:final`,
        sessionId,
        role: "assistant" as const,
        content: "done",
      },
    } : {}),
  });
}

function successfulStart() {
  return { promise: Promise.resolve({ content: "resumed", success: true }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("RuntimeInteractionCoordinator", () => {
  it("returns an unresolved result for an unavailable interaction", async () => {
    const store = createStore();
    seedRoot(store);
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const { coordinator } = createCoordinator(storage, vi.fn(successfulStart));

    await expect(coordinator.respondApprovalAsync("session-1", "missing-interaction", {
      approved: true,
      message: "continue",
    })).resolves.toEqual({
      resolved: false,
      needsResume: false,
      kind: "approval",
      interactionId: "missing-interaction",
    });
  });

  it("records stable required/responded events before settling a live waiter", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "session-1", "usr_local");
    store.createRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "running",
      taskSummary: "approve",
      requestId: "request-1",
      userId: "usr_local",
      agentName: "orchestrator_agent",
      threadKey: "root",
    });
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const dispatchRows = vi.fn(async () => []);
    const coordinator = new RuntimeInteractionCoordinator(
      storage,
      new AsyncDurableClientEventPublisher(storage, { dispatchRows }),
    );
    const onInteractionRequired = vi.fn();

    const waiting = coordinator.waitForApproval({
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "run-1",
      parentRunId: null,
      parentCallId: null,
      requestId: "request-1",
      toolCallId: "tool-1",
      deadlineMs: 5_000,
      task: "approve",
      toolName: "execute_bash",
      onInteractionRequired,
    });
    await vi.waitFor(() => expect(onInteractionRequired).toHaveBeenCalledOnce());
    const interactionId = onInteractionRequired.mock.calls[0]?.[0].interactionId as string;

    const response = await coordinator.respondApprovalAsync("session-1", interactionId, {
      approved: true,
      message: "ok",
    });
    await expect(waiting).resolves.toMatchObject({ approvalId: interactionId, approved: true, message: "ok" });
    expect(response).toMatchObject({ resolved: true, needsResume: false });

    const eventIds = store.listOutboxForReplay({ sessionId: "session-1" }).map((row) => row.event_id);
    expect(eventIds).toEqual([`${interactionId}:required`, `${interactionId}:responded`]);
    expect(dispatchRows).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("times out only the live waiter and leaves durable status unchanged", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    store.createSession(LOCAL_TENANT_ID, "session-timeout", "usr_local");
    store.createRun({
      runId: "run-timeout",
      sessionId: "session-timeout",
      status: "running",
      taskSummary: "wait",
      requestId: "request-timeout",
      userId: "usr_local",
      agentName: "orchestrator_agent",
      threadKey: "root",
    });
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const coordinator = new RuntimeInteractionCoordinator(
      storage,
      new AsyncDurableClientEventPublisher(storage, { dispatchRows: async () => [] }),
    );
    let interactionId = "";
    const waiting = coordinator.waitForUserInput({
      sessionId: "session-timeout",
      runId: "run-timeout",
      rootRunId: "run-timeout",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-timeout",
      deadlineMs: 5,
      task: "wait",
      prompt: "value?",
      onInteractionRequired: (notice) => { interactionId = notice.interactionId; },
    });

    await expect(waiting).rejects.toBeInstanceOf(RecoverableInterrupt);
    expect(store.getPendingInteraction("session-timeout", interactionId)?.status).toBe("waiting");
    store.close();
  });

  it("cleans the waiter and metadata when the required record fails", async () => {
    const store = createStore();
    seedRoot(store);
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const failure = new Error("required write failed");
    let interactionId = "";
    const recordInteraction = vi.fn(async (input: Parameters<RuntimeStorage["operations"]["recordInteraction"]>[0]) => {
      interactionId = input.interaction.interactionId;
      throw failure;
    });
    const failingStorage: RuntimeStorage = {
      tenantId: storage.tenantId,
      operations: { ...storage.operations, recordInteraction },
    };
    const { coordinator } = createCoordinator(failingStorage);
    const onInteractionRequired = vi.fn();

    const waiting = coordinator.waitForApproval({
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "run-1",
      parentRunId: null,
      parentCallId: null,
      toolCallId: "tool-failed",
      deadlineMs: 5_000,
      task: "approve",
      toolName: "execute_bash",
      onInteractionRequired,
    });

    await expect(waiting).rejects.toBe(failure);
    expect(interactionId).not.toBe("");
    expect(coordinator.isApprovalPending("session-1", interactionId)).toBe(false);
    expect(coordinator.peekApprovalMeta(interactionId, "session-1")).toBeNull();
    expect(onInteractionRequired).not.toHaveBeenCalled();
    expect(store.getPendingInteraction("session-1", interactionId)).toBeNull();
    expect(store.listOutboxForReplay({ sessionId: "session-1" })).toEqual([]);
  });

  it("replays the same response after runtime restart and starts one durable claim", async () => {
    const dataRoot = makeTempRoot();
    const dbPath = path.join(dataRoot, "coordinator-restart.db");
    const storeA = createStore(dbPath, dataRoot);
    seedRoot(storeA);
    const storageA = new SqliteRuntimeStorage(LOCAL_TENANT_ID, storeA);
    const { coordinator: runtimeA } = createCoordinator(storageA);
    const interactionId = await recordTimedOutApproval(runtimeA, { toolCallId: "tool-restart" });
    await finalizeRoot(storageA, "suspended");
    closeStore(storeA);

    const storeB = createStore(dbPath, dataRoot);
    const storageB = new SqliteRuntimeStorage(LOCAL_TENANT_ID, storeB);
    const startClaim = vi.fn(successfulStart);
    const { coordinator: runtimeB } = createCoordinator(storageB, startClaim);

    const first = await runtimeB.respondApprovalAsync("session-1", interactionId, {
      approved: true,
      message: "continue",
    });
    const replay = await runtimeB.respondApprovalAsync("session-1", interactionId, {
      approved: true,
      message: "continue",
    });

    expect(first).toMatchObject({ resolved: true, needsResume: true, rootRunId: "run-1" });
    expect(replay).toMatchObject({ resolved: true, needsResume: false, rootRunId: "run-1" });
    expect(startClaim).toHaveBeenCalledOnce();
    expect(storeB.getRun("session-1", "run-1")?.status).toBe("running");
    expect(storeB.getPendingInteraction("session-1", interactionId)).toMatchObject({
      status: "resuming",
      resolution_payload: { approved: true, message: "continue" },
    });
    expect(storeB.listOutboxForReplay({ sessionId: "session-1" })
      .filter((row) => row.event_id === `${interactionId}:responded`)).toHaveLength(1);
  });

  it("waits for the last response in a batch before starting resume", async () => {
    const store = createStore();
    seedRoot(store);
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const startClaim = vi.fn(successfulStart);
    const { coordinator } = createCoordinator(storage, startClaim);
    const firstId = await recordTimedOutApproval(coordinator, { toolCallId: "tool-batch-1", batchId: "batch" });
    const secondId = await recordTimedOutApproval(coordinator, { toolCallId: "tool-batch-2", batchId: "batch" });
    const finalized = await finalizeRoot(storage, "suspended");
    await coordinator.onRootFinalized("session-1", "run-1", "suspended", finalized.readyResumeInteractionIds);

    const first = await coordinator.respondApprovalAsync("session-1", firstId, {
      approved: true,
      message: "one",
    });
    expect(first).toMatchObject({ resolved: true, needsResume: false });
    expect(startClaim).not.toHaveBeenCalled();

    const second = await coordinator.respondApprovalAsync("session-1", secondId, {
      approved: true,
      message: "two",
    });
    expect(second).toMatchObject({ resolved: true, needsResume: true });
    expect(startClaim).toHaveBeenCalledOnce();
    expect(store.getRun("session-1", "run-1")?.status).toBe("running");
  });

  it("starts only one claim for concurrent identical responses", async () => {
    const store = createStore();
    seedRoot(store);
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const startClaim = vi.fn(successfulStart);
    const { coordinator } = createCoordinator(storage, startClaim);
    const interactionId = await recordTimedOutApproval(coordinator, { toolCallId: "tool-concurrent" });
    const finalized = await finalizeRoot(storage, "suspended");
    await coordinator.onRootFinalized("session-1", "run-1", "suspended", finalized.readyResumeInteractionIds);

    const responses = await Promise.all([
      coordinator.respondApprovalAsync("session-1", interactionId, { approved: true, message: "same" }),
      coordinator.respondApprovalAsync("session-1", interactionId, { approved: true, message: "same" }),
    ]);

    expect(responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ resolved: true }),
      expect.objectContaining({ resolved: true }),
    ]));
    expect(startClaim).toHaveBeenCalledOnce();
    expect(store.listOutboxForReplay({ sessionId: "session-1" })
      .filter((row) => row.event_id === `${interactionId}:responded`)).toHaveLength(1);
  });

  it("defers a ready response while the root is running and starts after suspended finalization", async () => {
    const store = createStore();
    seedRoot(store);
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const startClaim = vi.fn(successfulStart);
    const { coordinator } = createCoordinator(storage, startClaim);
    const interactionId = await recordTimedOutApproval(coordinator, { toolCallId: "tool-deferred" });

    const response = await coordinator.respondApprovalAsync("session-1", interactionId, {
      approved: true,
      message: "defer",
    });
    expect(response).toMatchObject({ resolved: true, needsResume: true });
    expect(startClaim).not.toHaveBeenCalled();
    expect(store.getRun("session-1", "run-1")?.status).toBe("running");

    const finalized = await finalizeRoot(storage, "suspended");
    await coordinator.onRootFinalized("session-1", "run-1", "suspended", finalized.readyResumeInteractionIds);

    expect(startClaim).toHaveBeenCalledOnce();
    expect(store.getRun("session-1", "run-1")?.status).toBe("running");
  });

  it("rolls back a synchronous start failure and allows the same response to retry", async () => {
    const store = createStore();
    seedRoot(store);
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const startClaim = vi.fn()
      .mockImplementationOnce(() => { throw new Error("start failed"); })
      .mockImplementation(successfulStart);
    const { coordinator } = createCoordinator(storage, startClaim);
    const interactionId = await recordTimedOutApproval(coordinator, { toolCallId: "tool-retry" });
    const finalized = await finalizeRoot(storage, "suspended");
    await coordinator.onRootFinalized("session-1", "run-1", "suspended", finalized.readyResumeInteractionIds);

    await expect(coordinator.respondApprovalAsync("session-1", interactionId, {
      approved: true,
      message: "retry",
    })).rejects.toThrow("start failed");
    expect(store.getRun("session-1", "run-1")?.status).toBe("suspended");
    expect(store.getPendingInteraction("session-1", interactionId)).toMatchObject({
      status: "resolved",
      resume_claim_id: null,
    });

    await expect(coordinator.respondApprovalAsync("session-1", interactionId, {
      approved: true,
      message: "retry",
    })).resolves.toMatchObject({ resolved: true, needsResume: true });
    expect(startClaim).toHaveBeenCalledTimes(2);
    expect(store.getRun("session-1", "run-1")?.status).toBe("running");
  });

  it("keeps terminal response replay idempotent and one stable responded outbox row", async () => {
    const store = createStore();
    seedRoot(store);
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const { coordinator } = createCoordinator(storage);
    const resolvedId = await recordTimedOutApproval(coordinator, {
      toolCallId: "tool-terminal-resolved",
      batchId: "resolved",
    });
    const cancelledId = await recordTimedOutApproval(coordinator, {
      toolCallId: "tool-terminal-cancelled",
      batchId: "cancelled",
    });
    await coordinator.respondApprovalAsync("session-1", resolvedId, {
      approved: true,
      message: "terminal",
    });

    const finalized = await finalizeRoot(storage, "completed");
    await coordinator.onRootFinalized("session-1", "run-1", "completed", finalized.readyResumeInteractionIds);

    await expect(coordinator.respondApprovalAsync("session-1", resolvedId, {
      approved: true,
      message: "terminal",
    })).resolves.toMatchObject({ resolved: true, needsResume: false });
    await expect(coordinator.respondApprovalAsync("session-1", resolvedId, {
      approved: false,
      message: "conflict",
    })).rejects.toThrow("resolution conflict");
    await expect(coordinator.respondApprovalAsync("session-1", cancelledId, {
      approved: true,
      message: "too late",
    })).resolves.toMatchObject({
      resolved: false,
      needsResume: false,
      interactionId: cancelledId,
    });
    expect(store.getPendingInteraction("session-1", resolvedId)?.status).toBe("consumed");
    expect(store.getPendingInteraction("session-1", cancelledId)?.status).toBe("cancelled");
    expect(store.listOutboxForReplay({ sessionId: "session-1" })
      .filter((row) => row.event_id === `${resolvedId}:responded`)).toHaveLength(1);
  });

  it("reports the new interaction id when a resumed run suspends again", async () => {
    const store = createStore();
    seedRoot(store);
    const storage = new SqliteRuntimeStorage(LOCAL_TENANT_ID, store);
    const resumed = deferred<{ content: string; success: boolean; suspended?: boolean }>();
    const startClaim = vi.fn(() => ({ promise: resumed.promise }));
    const { coordinator } = createCoordinator(storage, startClaim);
    const firstId = await recordTimedOutApproval(coordinator, { toolCallId: "tool-first" });
    const firstFinalized = await finalizeRoot(storage, "suspended");
    await coordinator.onRootFinalized("session-1", "run-1", "suspended", firstFinalized.readyResumeInteractionIds);
    const onSuspended = vi.fn();
    await coordinator.respondApprovalAsync(
      "session-1",
      firstId,
      { approved: true, message: "continue" },
      { onSuspended },
    );

    let nextId = "";
    const nextWaiting = coordinator.waitForApproval({
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "run-1",
      parentRunId: null,
      parentCallId: null,
      rootCallId: "root-call-1",
      toolCallId: "tool-next",
      deadlineMs: 5_000,
      task: "approve again",
      toolName: "write_file",
      onInteractionRequired: (notice) => { nextId = notice.interactionId; },
    });
    await vi.waitFor(() => expect(nextId).not.toBe(""));
    const nextRejected = expect(nextWaiting).rejects.toThrow("interaction root finalized: suspended");
    const secondFinalized = await finalizeRoot(storage, "suspended");
    await coordinator.onRootFinalized("session-1", "run-1", "suspended", secondFinalized.readyResumeInteractionIds);
    await nextRejected;

    resumed.resolve({ content: "", success: true, suspended: true });
    await vi.waitFor(() => expect(onSuspended).toHaveBeenCalledWith(nextId));
    expect(onSuspended).not.toHaveBeenCalledWith(firstId);
    expect(store.getPendingInteraction("session-1", nextId)?.status).toBe("suspended");
  });
});
