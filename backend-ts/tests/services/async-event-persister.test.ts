import { describe, expect, it } from "vitest";

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
      rollbackResume: async () => {
        throw new Error("persister must not roll back resumes");
      },
      finalizeRun: async (input) => {
        lifecycle.push("finalize");
        finalizes.push(input);
        const finalMessage = input.finalMessage ? persist(input.finalMessage) : null;
        const records = (input.buildTerminalRecords?.(finalMessage) ?? []).map((record, index) => ({
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
        }));
        return { finalMessage, records, readyResumeInteractionIds };
      },
    },
  };
  const clientEvents = {
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
  return { storage, clientEvents, fileHistory, starts, persists, finalizes, delivered, snapshots, messages, lifecycle };
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
      context({ initialUserMessage: { id: "user-1", content: "question" } }),
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
    expect(harness.delivered[0]?.map((row) => row.event_id)).toEqual(
      terminalInputs.map((record) => record.outbox.eventId),
    );
    expect(harness.lifecycle).toEqual(["flush", "finalize", "deliver"]);
    expect(harness.snapshots).toEqual([["session-1", 4]]);
    expect(persister.resolveFinalMessage()).toMatchObject({ id: "run-1:final", content: "answer" });
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
    expect(persister.resolveFinalMessage()).toBeNull();
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
    expect(persister.resolveFinalMessage()).toBeNull();
  });
});
