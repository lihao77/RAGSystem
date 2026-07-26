import { describe, expect, it, vi } from "vitest";

import type { MessageInfo } from "../../src/contracts/session/session.js";
import type {
  RuntimeFinalizeRunInput,
  RuntimePersistMessageInput,
  RuntimeRecordEnvelopeInput,
  RuntimeStorage,
  RuntimeStartRunInput,
} from "../../src/contracts/storage/runtime-storage.js";
import { AsyncKernelEventPersister } from "../../src/services/agent/sdk/async-event-persister.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

const NOW = "2026-01-01T00:00:00.000Z";

function createHarness(readyResumeInteractionIds: string[] = []) {
  const starts: RuntimeStartRunInput[] = [];
  const persists: RuntimePersistMessageInput[] = [];
  const finalizes: RuntimeFinalizeRunInput[] = [];
  const delivered: Array<Array<{ event_id: string }>> = [];
  const snapshots: Array<[string, number]> = [];
  const lifecycle: string[] = [];
  const messages = new Map<string, MessageInfo>();
  let nextSeq = 1;

  const recordResult = (record: RuntimeRecordEnvelopeInput, index: number) => ({
    step: record.step ? {
      id: index + 1,
      run_id: record.step.runId,
      event_id: record.outbox.eventId,
      step_order: index + 1,
      step_type: record.step.stepType,
    } : null,
    outbox: {
      id: index + 1,
      event_id: record.outbox.eventId,
      session_id: record.outbox.sessionId,
      tenant_id: LOCAL_TENANT_ID,
      run_id: record.outbox.runId ?? null,
      session_seq: index + 1,
      event_type: record.outbox.eventType,
      aggregate_type: record.outbox.aggregateType,
      aggregate_id: record.outbox.aggregateId,
      payload: JSON.stringify(record.outbox.payload),
      status: "pending" as const,
      attempts: 0,
      available_at: NOW,
      locked_at: null,
      delivered_at: null,
      last_error: null,
      created_at: NOW,
    },
  });

  const persist = (input: RuntimePersistMessageInput["message"]): MessageInfo => {
    const existing = messages.get(input.messageId);
    if (existing) return existing;
    const value: MessageInfo = {
      id: input.messageId,
      seq: nextSeq++,
      session_id: input.sessionId,
      role: input.role,
      content: input.content,
      metadata: input.metadata ?? {},
      thread_key: input.threadKey ?? "root",
      child_agent_id: input.childAgentId ?? null,
      created_at: NOW,
      ...(input.toolCalls ? { tool_calls: input.toolCalls } : {}),
      ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {}),
      ...(input.name ? { name: input.name } : {}),
    };
    messages.set(value.id, value);
    return value;
  };

  const storage: RuntimeStorage = {
    tenantId: LOCAL_TENANT_ID,
    operations: {
      startRun: async (input) => {
        starts.push(input);
        const initialUserMessage = input.initialUserMessage
          ? persist(input.initialUserMessage)
          : null;
        return {
          run: {
            run_id: input.run.runId,
            session_id: input.run.sessionId,
            status: input.run.status ?? "running",
            thread_key: input.run.threadKey ?? "root",
            parent_run_id: input.run.parentRunId ?? null,
            parent_call_id: input.run.parentCallId ?? null,
            child_agent_id: input.run.childAgentId ?? null,
          },
          initialUserMessage,
          records: (input.initialRecords ?? []).map(recordResult),
        };
      },
      startOrAppendRoot: async (input) => {
        starts.push(input);
        const initialUserMessage = input.initialUserMessage ? persist(input.initialUserMessage) : null;
        return {
          kind: "started" as const,
          run: { run_id: input.run.runId, session_id: input.run.sessionId, status: input.run.status ?? "running", thread_key: input.run.threadKey ?? "root", parent_run_id: null, parent_call_id: null, child_agent_id: null },
          initialUserMessage,
          records: (input.initialRecords ?? []).map(recordResult),
        };
      },
      persistMessage: async (input) => {
        persists.push(input);
        return {
          message: persist(input.message),
          deletedProviderContinuations: input.deleteProviderContinuationThreadKey ? 1 : 0,
          providerContinuation: null,
        };
      },
      recordEnvelope: async () => {
        throw new Error("persister terminal flow must use finalizeRun");
      },
      recordInteraction: async () => {
        throw new Error("persister must not record interactions");
      },
      resolveInteraction: async () => {
        throw new Error("persister must not resolve interactions");
      },
      claimResume: async () => {
        throw new Error("persister must not claim resumes");
      },
      renewResumeClaim: async () => {
        throw new Error("persister must not renew resume claims");
      },
      recoverExpiredResumeClaims: async () => {
        throw new Error("persister must not recover resume claims");
      },
      rollbackResume: async () => {
        throw new Error("persister must not roll back resumes");
      },
      interruptSession: async () => ({ interruptedRuns: [], cancelledInteractions: 0, records: [] }),
      finalizeRun: async (input) => {
        lifecycle.push("finalize");
        finalizes.push(input);
        const finalMessage = input.finalMessage ? persist(input.finalMessage) : null;
        const records = (input.buildTerminalRecords?.(finalMessage) ?? []).map(recordResult);
        return { finalMessage, records, readyResumeInteractionIds };
      },
    },
  };
  const clientEvents = {
    prepare: (sessionId: string, event: Record<string, unknown>, options: { eventId: string; runId: string }) => ({
      step: null,
      outbox: {
        sessionId,
        runId: options.runId,
        eventId: options.eventId,
        eventType: `client.${String(event.type)}`,
        aggregateType: "run",
        aggregateId: options.runId,
        payload: { client_event: event },
      },
    }),
    flush: async () => { lifecycle.push("flush"); },
    deliver: async (rows: Array<{ event_id: string }>) => {
      lifecycle.push("deliver");
      delivered.push(rows);
    },
  };
  const fileHistory = {
    makeSnapshot: async (sessionId: string, seq: number) => {
      snapshots.push([sessionId, seq]);
      return "snapshot";
    },
  };
  return { storage, clientEvents, fileHistory, starts, persists, finalizes, delivered, snapshots, messages, lifecycle, persistMessage: persist };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: LOCAL_TENANT_ID,
    sessionId: "session-1",
    runId: "run-1",
    rootRunId: "run-1",
    threadKey: "root",
    agentName: "agent-1",
    agentDisplayName: "Agent One",
    rootCallId: "call-root",
    taskId: "task-1",
    providerType: "anthropic",
    executionKind: "agent_stream",
    requestId: "request-1",
    userId: "user-1",
    ...overrides,
  } as const;
}

describe("AsyncKernelEventPersister", () => {
  it("persists deterministic incremental messages and completes with atomic terminal records", async () => {
    const harness = createHarness();
    const persister = new AsyncKernelEventPersister(
      harness.storage,
      harness.clientEvents as never,
      context({
        initialUserMessage: { id: "user-1", content: "question" },
        initialEnvelopes: [
          { type: "run_started", session_id: "session-1", run_id: "run-1", payload: {} },
          { type: "agent_started", session_id: "session-1", run_id: "run-1", payload: {} },
        ],
      }),
      harness.fileHistory as never,
    );

    await persister.startRun();
    await persister.persist({
      type: "assistant_intermediate",
      round: 0,
      message: {
        role: "assistant",
        content: "intent",
        tool_calls: [{ id: "tool-1", type: "function", function: { name: "search", arguments: "{}" } }],
        provider_continuation: {
          protocol: "anthropic_messages",
          toolCallIds: ["tool-1"],
          blocks: [{ type: "thinking", thinking: "private", signature: "sig" }],
        },
      },
    } as never);
    await persister.persist({
      type: "tool_result",
      round: 0,
      toolCallId: "tool-1",
      toolName: "search",
      observation: "result",
      metadata: { tool_result_media: [{ type: "image", path: "result.png" }] },
    } as never);
    const finalizedResult = await persister.finalize("completed", { content: "answer" });

    expect(harness.starts[0]).toMatchObject({
      session: { sessionId: "session-1", userId: "user-1" },
      run: { runId: "run-1", agentName: "agent-1" },
      initialUserMessage: { messageId: "user-1", content: "question" },
    });
    expect(harness.starts[0]).toHaveProperty("buildExpiredRunEndedRecord");
    expect(harness.starts[0]?.initialRecords?.map((record) => record.outbox.eventId)).toEqual([
      "run-1:initial:0:run_started",
      "run-1:initial:1:agent_started",
    ]);
    expect(harness.delivered[0]?.map((record) => record.event_id)).toEqual([
      "run-1:initial:0:run_started",
      "run-1:initial:1:agent_started",
    ]);
    expect(harness.persists.map((item) => item.message.messageId)).toEqual([
      "run-1:intent:0",
      "run-1:tool:tool-1",
    ]);
    expect(harness.persists[0]).toMatchObject({
      deleteProviderContinuationThreadKey: "root",
      providerContinuation: {
        messageId: "run-1:intent:0",
        providerType: "anthropic",
        toolCallIds: ["tool-1"],
      },
    });
    expect(harness.persists[1]?.message.metadata).toMatchObject({
      msg_type: "observation",
      react_intermediate: true,
      extensions: [{ kind: "tool_result_media" }],
    });
    expect(harness.finalizes[0]?.finalMessage).toMatchObject({
      messageId: "run-1:final",
      content: "answer",
      metadata: { msg_type: "assistant_final", task_id: "task-1" },
    });
    expect(harness.finalizes[0]?.interactionRootRunId).toBe("run-1");
    expect(finalizedResult.readyResumeInteractionIds).toEqual([]);
    const terminalInputs = harness.finalizes[0]?.buildTerminalRecords?.(
      harness.messages.get("run-1:final") ?? null,
    ) ?? [];
    expect(terminalInputs.map((record) => record.outbox.eventId)).toEqual([
      "run-1:terminal:0:stream_output",
      "run-1:terminal:1:state_sync",
      "run-1:terminal:2:agent_ended",
      "run-1:terminal:3:run_ended",
    ]);
    expect(terminalInputs[2]?.outbox.payload).toMatchObject({
      client_event: { payload: { display_name: "Agent One", success: true } },
    });
    expect(harness.delivered.at(-1)?.map((row) => row.event_id)).toEqual(
      terminalInputs.map((record) => record.outbox.eventId),
    );
    expect(harness.lifecycle).toEqual(["deliver", "flush", "finalize", "deliver"]);
    expect(harness.snapshots).toEqual([["session-1", 4]]);
    expect(await persister.resolveFinalMessage()).toMatchObject({ id: "run-1:final", content: "answer" });
  });

  it("persists an active-root followup before acknowledging it", async () => {
    const harness = createHarness();
    let startInput: { deferFollowup?: boolean } | null = null;
    harness.storage.operations.startOrAppendRoot = async (input) => {
      startInput = input;
      const built = input.followupFactory({ activeRunId: "active-run", roundIndex: 3 });
      const message = harness.persistMessage(built.message);
      return {
        kind: "followup",
        activeRunId: "active-run",
        message,
        records: built.recordFactory(message).map((record, index) => ({
          step: null,
          outbox: {
            id: index + 1, event_id: record.outbox.eventId, session_id: record.outbox.sessionId,
            tenant_id: LOCAL_TENANT_ID, run_id: record.outbox.runId ?? null, session_seq: index + 1,
            event_type: record.outbox.eventType, aggregate_type: record.outbox.aggregateType,
            aggregate_id: record.outbox.aggregateId, payload: JSON.stringify(record.outbox.payload),
            status: "pending" as const, attempts: 0, available_at: NOW, locked_at: null,
            delivered_at: null, last_error: null, created_at: NOW,
          },
        })),
      };
    };
    const persister = new AsyncKernelEventPersister(
      harness.storage,
      harness.clientEvents as never,
      context({ initialUserMessage: { id: "followup-user", content: "later" } }),
    );

    await expect(persister.startRun()).resolves.toEqual({
      kind: "followup",
      activeRunId: "active-run",
      queueAccepted: true,
      messageId: "followup-user",
      messageSeq: 1,
    });
    expect(startInput).not.toHaveProperty("deferFollowup", true);
    expect(harness.messages.get("followup-user")).toMatchObject({
      content: "later",
      metadata: { run_id: "active-run", execution_kind: "session_followup", round_index: 3 },
    });
    expect(harness.delivered[0]?.map((row) => row.event_id)).toEqual(["followup-user:followup:state_sync"]);
  });

  it("renews the root lease before persistence and refuses writes after ownership is lost", async () => {
    const harness = createHarness();
    const renewals: string[] = [];
    let owned = true;
    harness.storage.operations.renewRunLease = async (input) => {
      renewals.push(input.rootRunId);
      return { renewed: owned, expiresAt: owned ? "2099-01-01T00:00:00.000Z" : null };
    };
    const persister = new AsyncKernelEventPersister(
      harness.storage,
      harness.clientEvents as never,
      context({ initialUserMessage: { id: "user-1", content: "question" } }),
    );
    await persister.startRun();

    await persister.persist({
      type: "assistant_intermediate",
      round: 0,
      message: { role: "assistant", content: "working" },
    } as never);
    owned = false;
    await expect(persister.persist({
      type: "assistant_intermediate",
      round: 1,
      message: { role: "assistant", content: "stale write" },
    } as never)).rejects.toThrow("root run lease was lost");

    expect(renewals).toEqual(["run-1", "run-1"]);
    expect(harness.persists.map((item) => item.message.content)).toEqual(["working"]);
  });

  it("creates an interrupted anchor, clears continuations, and records failure terminal events", async () => {
    const harness = createHarness();
    const persister = new AsyncKernelEventPersister(
      harness.storage,
      harness.clientEvents as never,
      context(),
      harness.fileHistory as never,
    );
    await persister.startRun();

    await persister.finalize("interrupted", null, new Error("aborted"));

    const finalized = harness.finalizes[0]!;
    expect(finalized.finalMessage).toMatchObject({
      messageId: "run-1:interrupted",
      role: "assistant",
      content: "",
      metadata: { interrupted: true, msg_type: "assistant_final" },
    });
    expect(finalized.deleteProviderContinuationThreadKey).toBe("root");
    expect(finalized.closeDanglingToolCalls).toEqual({
      threadKey: "root",
      agentName: "agent-1",
    });
    const records = finalized.buildTerminalRecords?.(
      harness.messages.get("run-1:interrupted") ?? null,
    ) ?? [];
    expect(records.map((record) => record.outbox.eventId)).toEqual([
      "run-1:terminal:0:agent_ended",
      "run-1:terminal:1:run_ended",
    ]);
    expect(records[0]?.outbox.payload).toMatchObject({
      client_event: { payload: { result: "[已停止生成]", success: false } },
    });
    expect(harness.snapshots).toEqual([]);
  });

  it("suspends the root interaction tree without producing terminal events", async () => {
    const harness = createHarness();
    const persister = new AsyncKernelEventPersister(
      harness.storage,
      harness.clientEvents as never,
      context({ runId: "child-run", rootRunId: "root-run", childAgentId: "child-1" }),
    );
    await persister.startRun();

    await persister.finalize("suspended", null);

    expect(harness.finalizes[0]).toMatchObject({
      runId: "child-run",
      status: "suspended",
      finalMessage: null,
    });
    expect(harness.finalizes[0]).not.toHaveProperty("interactionRootRunId");
    expect(harness.delivered).toEqual([[]]);
    expect(await persister.resolveFinalMessage()).toBeNull();
  });

  it("passes the root interaction scope and returns ready resume ids", async () => {
    const harness = createHarness(["interaction-ready"]);
    const persister = new AsyncKernelEventPersister(
      harness.storage,
      harness.clientEvents as never,
      context(),
      harness.fileHistory as never,
    );
    await persister.startRun();

    const result = await persister.finalize("suspended", null);

    expect(harness.finalizes[0]).toMatchObject({
      runId: "run-1",
      status: "suspended",
      interactionRootRunId: "run-1",
    });
    expect(result.readyResumeInteractionIds).toEqual(["interaction-ready"]);
  });

  it("does not finalize when queued client-event persistence fails during flush", async () => {
    const harness = createHarness();
    const writeFailure = new Error("queued event write failed");
    harness.clientEvents.flush = async () => {
      harness.lifecycle.push("flush");
      throw writeFailure;
    };
    const persister = new AsyncKernelEventPersister(
      harness.storage,
      harness.clientEvents as never,
      context(),
      harness.fileHistory as never,
    );
    await persister.startRun();

    await expect(persister.finalize("completed", { content: "must not commit" }))
      .rejects.toBe(writeFailure);

    expect(harness.lifecycle).toEqual(["flush"]);
    expect(harness.finalizes).toEqual([]);
    expect(harness.delivered).toEqual([]);
    expect(harness.messages.has("run-1:final")).toBe(false);
    expect(await persister.resolveFinalMessage()).toBeNull();
  });

  it("stops the lease heartbeat when finalization fails before the terminal transaction", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      let renewals = 0;
      harness.storage.operations.renewRunLease = async () => {
        renewals += 1;
        return { renewed: true, expiresAt: "2099-01-01T00:00:00.000Z" };
      };
      harness.clientEvents.flush = async () => { throw new Error("flush failed"); };
      const persister = new AsyncKernelEventPersister(
        harness.storage,
        harness.clientEvents as never,
        context(),
      );
      await persister.startRun();
      await expect(persister.finalize("failed", null)).rejects.toThrow("flush failed");
      const stoppedAt = renewals;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(renewals).toBe(stoppedAt);
    } finally {
      vi.useRealTimers();
    }
  });
});
