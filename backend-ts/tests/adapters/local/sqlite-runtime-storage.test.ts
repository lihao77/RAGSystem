import { afterEach, describe, expect, it } from "vitest";

import { SqliteRuntimeStorage } from "../../../src/adapters/local/sqlite-runtime-storage.js";
import { createConversationStore } from "../../../src/adapters/local/sqlite/conversation-store/index.js";
import type { ConversationStore } from "../../../src/contracts/conversation-store/index.js";
import { LOCAL_TENANT_ID } from "../../../src/services/identity/index.js";

const stores: ConversationStore[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function createHarness() {
  const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
  stores.push(store);
  return { store, storage: new SqliteRuntimeStorage(LOCAL_TENANT_ID, store) };
}

async function startRun(storage: SqliteRuntimeStorage, runId = "run-1") {
  return storage.operations.startRun({
    session: { sessionId: "session-1", userId: "user-1" },
    run: { runId, sessionId: "session-1", status: "running" },
  });
}

function persistMessageInput(messageId: string) {
  return {
    message: {
      messageId,
      sessionId: "session-1",
      role: "assistant" as const,
      content: "working",
      threadKey: "root",
      toolCalls: [{ id: "tool-1", type: "function" as const, function: { name: "search", arguments: "{}" } }],
    },
    providerContinuation: {
      messageId,
      sessionId: "session-1",
      threadKey: "root",
      providerType: "anthropic",
      toolCallIds: ["tool-1"],
      state: {
        protocol: "anthropic_messages" as const,
        toolCallIds: ["tool-1"],
        blocks: [{ type: "thinking" as const, thinking: "private", signature: "sig" }],
      },
    },
  };
}

function interactionInput(interactionId: string, toolCallId: string, batchId = "batch-1") {
  return {
    interactionId,
    sessionId: "session-1",
    runId: "run-1",
    rootRunId: "run-1",
    toolCallId,
    batchId,
    kind: "approval" as const,
    requestPayload: {
      task: "approve tools",
      requestId: "request-1",
      executionKind: "agent_stream",
    },
  };
}

function interactionRecord(
  interaction: ReturnType<typeof interactionInput>,
  phase: "required" | "responded",
) {
  const eventId = `${interaction.interactionId}:${phase}`;
  const event = {
    type: "interaction",
    session_id: interaction.sessionId,
    run_id: interaction.runId,
    call_id: interaction.interactionId,
    payload: { kind: interaction.kind, phase },
  };
  return {
    step: {
      sessionId: interaction.sessionId,
      runId: interaction.runId,
      stepType: "protocol.envelope.v1",
      payload: event,
    },
    outbox: {
      eventId,
      sessionId: interaction.sessionId,
      runId: interaction.runId,
      eventType: "client.interaction",
      aggregateType: "run",
      aggregateId: interaction.runId,
      payload: { client_event: event },
    },
  };
}

async function startInteractionRun(storage: SqliteRuntimeStorage) {
  return storage.operations.startRun({
    session: {
      sessionId: "session-1",
      userId: "user-1",
      metadata: { source: "contract-test" },
    },
    run: {
      runId: "run-1",
      sessionId: "session-1",
      status: "running",
      agentName: "agent-1",
      taskSummary: "approve tools",
      requestId: "request-1",
      userId: "user-1",
      entrypoint: "agent_stream",
    },
  });
}

describe("SqliteRuntimeStorage", () => {
  it("exposes only tenant identity and fixed atomic operations", () => {
    const { storage } = createHarness();

    expect(storage.tenantId).toBe(LOCAL_TENANT_ID);
    expect(storage.operations).toEqual({
      startRun: expect.any(Function),
      persistMessage: expect.any(Function),
      recordEnvelope: expect.any(Function),
      recordInteraction: expect.any(Function),
      resolveInteraction: expect.any(Function),
      claimResume: expect.any(Function),
      rollbackResume: expect.any(Function),
      finalizeRun: expect.any(Function),
    });
    expect(storage).not.toHaveProperty("conversation");
    expect(storage).not.toHaveProperty("runs");
    expect(storage).not.toHaveProperty("outbox");
  });

  it("persists a deterministic message and provider continuation atomically and idempotently", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    const input = persistMessageInput("message-1");

    const first = await storage.operations.persistMessage(input);
    const replay = await storage.operations.persistMessage(input);

    expect(replay.message).toEqual(first.message);
    expect(replay.providerContinuation?.message_id).toBe("message-1");
    expect(store.listMessages("session-1").items).toHaveLength(1);
    expect(store.getProviderContinuation("session-1", "message-1")?.state).toEqual(
      input.providerContinuation?.state,
    );
  });

  it("deletes the previous continuation before storing the replacement", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    await storage.operations.persistMessage(persistMessageInput("message-old"));

    const result = await storage.operations.persistMessage({
      ...persistMessageInput("message-new"),
      deleteProviderContinuationThreadKey: "root",
    });

    expect(result.deletedProviderContinuations).toBe(1);
    expect(store.getProviderContinuation("session-1", "message-old")).toBeNull();
    expect(store.getProviderContinuation("session-1", "message-new")).not.toBeNull();
  });

  it("rejects message and continuation identity conflicts", async () => {
    const { storage } = createHarness();
    await startRun(storage);
    await storage.operations.persistMessage(persistMessageInput("message-1"));

    await expect(storage.operations.persistMessage({
      ...persistMessageInput("message-1"),
      message: { ...persistMessageInput("message-1").message, content: "changed" },
    })).rejects.toThrow("message deterministic id conflict");
    await expect(storage.operations.persistMessage({
      ...persistMessageInput("message-2"),
      providerContinuation: {
        ...persistMessageInput("message-2").providerContinuation!,
        messageId: "other-message",
      },
    })).rejects.toThrow("provider continuation message mismatch");
  });

  it("rolls back the message when provider continuation persistence fails", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    const input = persistMessageInput("message-rollback");

    await expect(storage.operations.persistMessage({
      ...input,
      providerContinuation: { ...input.providerContinuation!, state: { invalid: true } as never },
    })).rejects.toThrow("Provider continuation insert failed");

    expect(store.getMessageById("session-1", "message-rollback")).toBeNull();
    expect(store.getProviderContinuation("session-1", "message-rollback")).toBeNull();
  });

  it("commits final message, terminal records, step attachment, and run status atomically", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    let builderMessageSeq: number | null = null;

    const result = await storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "completed",
      finalMessage: {
        messageId: "final-1",
        sessionId: "session-1",
        role: "assistant",
        content: "answer",
      },
      buildTerminalRecords: (message) => {
        builderMessageSeq = message?.seq ?? null;
        expect(store.getMessageById("session-1", "final-1")?.seq).toBe(builderMessageSeq);
        return [{
          step: {
            sessionId: "session-1",
            runId: "run-1",
            stepType: "protocol.envelope.v1",
            payload: { type: "run_ended", message_seq: message?.seq },
          },
          outbox: {
            eventId: "event-final-1",
            sessionId: "session-1",
            runId: "run-1",
            eventType: "client.run_ended",
            aggregateType: "run",
            aggregateId: "run-1",
            payload: { client_event: { message_seq: message?.seq } },
          },
        }];
      },
    });

    expect(builderMessageSeq).toBe(result.finalMessage?.seq);
    expect(store.getRun("session-1", "run-1")).toMatchObject({
      status: "completed",
      final_message_id: "final-1",
    });
    expect(store.listRunSteps({ sessionId: "session-1", runId: "run-1" })).toEqual([
      expect.objectContaining({ message_id: "final-1", step_order: 1 }),
    ]);
    expect(store.listOutboxForReplay({ sessionId: "session-1" })).toEqual([
      expect.objectContaining({ event_id: "event-final-1", session_seq: 1 }),
    ]);
  });

  it("rolls back all finalization writes when a later terminal record is invalid", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);

    await expect(storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "completed",
      finalMessage: {
        messageId: "final-rollback",
        sessionId: "session-1",
        role: "assistant",
        content: "must rollback",
      },
      buildTerminalRecords: () => [
        {
          step: { sessionId: "session-1", runId: "run-1", stepType: "event", payload: {} },
          outbox: {
            eventId: "event-before-error",
            sessionId: "session-1",
            runId: "run-1",
            eventType: "client.event",
            aggregateType: "run",
            aggregateId: "run-1",
            payload: {},
          },
        },
        {
          outbox: {
            eventId: "event-invalid",
            sessionId: "session-1",
            runId: "other-run",
            eventType: "client.event",
            aggregateType: "run",
            aggregateId: "other-run",
            payload: {},
          },
        },
      ],
    })).rejects.toThrow("terminal outbox run mismatch");

    expect(store.getMessageById("session-1", "final-rollback")).toBeNull();
    expect(store.listRunSteps({ sessionId: "session-1", runId: "run-1" })).toEqual([]);
    expect(store.listOutboxForReplay({ sessionId: "session-1" })).toEqual([]);
    expect(store.getRun("session-1", "run-1")?.status).toBe("running");
  });

  it("reuses a deterministic initial user message across separate run starts", async () => {
    const { store, storage } = createHarness();
    const initialUserMessage = {
      messageId: "user-message-1",
      sessionId: "session-1",
      role: "user" as const,
      content: "question",
    };

    const first = await storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-1" },
      run: { runId: "run-1", sessionId: "session-1" },
      initialUserMessage,
    });
    const second = await storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-1" },
      run: { runId: "run-2", sessionId: "session-1" },
      initialUserMessage,
    });

    expect(first.initialUserMessage?.id).toBe("user-message-1");
    expect(second.initialUserMessage?.id).toBe("user-message-1");
    expect(store.listMessages("session-1").items).toHaveLength(1);
    expect(store.listRuns("session-1").total).toBe(2);
  });

  it("reuses the same run id only when its immutable scope matches", async () => {
    const { store, storage } = createHarness();
    const input = {
      session: { sessionId: "session-1", userId: "user-1" },
      run: {
        runId: "run-stable",
        sessionId: "session-1",
        status: "running",
        agentName: "worker",
        threadKey: "child:1",
        parentRunId: "parent-run",
        parentCallId: "parent-call",
        childAgentId: "child-1",
      },
    };

    const first = await storage.operations.startRun(input);
    const replay = await storage.operations.startRun(input);

    expect(replay.run).toEqual(first.run);
    expect(store.listRuns("session-1").total).toBe(1);
  });

  it("does not overwrite an existing session while replaying startRun", async () => {
    const { store, storage } = createHarness();
    await storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-1", metadata: { source: "original" } },
      run: { runId: "run-1", sessionId: "session-1" },
    });

    await storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-2", metadata: { source: "retry" } },
      run: { runId: "run-2", sessionId: "session-1" },
    });

    expect(store.getSession("session-1")).toMatchObject({
      user_id: "user-1",
      metadata: { source: "original" },
    });
  });

  it("rejects a reused run id with a different scope and rolls back the new session", async () => {
    const { store, storage } = createHarness();
    await startRun(storage, "shared-run");

    await expect(storage.operations.startRun({
      session: { sessionId: "session-2", userId: "user-2" },
      run: { runId: "shared-run", sessionId: "session-2", threadKey: "child:other" },
      initialUserMessage: {
        messageId: "must-rollback",
        sessionId: "session-2",
        role: "user",
        content: "must rollback",
      },
    })).rejects.toThrow("run scope conflict");

    expect(store.getSession("session-2")).toBeNull();
    expect(store.getMessageById("session-2", "must-rollback")).toBeNull();
    expect(store.listRuns("session-1").total).toBe(1);
  });

  it("rejects a reused run id with a different scope in the same session", async () => {
    const { store, storage } = createHarness();
    await storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-1" },
      run: { runId: "scoped-run", sessionId: "session-1", threadKey: "root" },
    });

    await expect(storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-1" },
      run: { runId: "scoped-run", sessionId: "session-1", threadKey: "child:other" },
      initialUserMessage: {
        messageId: "scope-conflict-message",
        sessionId: "session-1",
        role: "user",
        content: "must rollback",
      },
    })).rejects.toThrow("run scope conflict");

    expect(store.getMessageById("session-1", "scope-conflict-message")).toBeNull();
    expect(store.listRuns("session-1").total).toBe(1);
  });

  it("rejects deterministic message reuse when immutable fields differ", async () => {
    const { store, storage } = createHarness();
    const original = {
      messageId: "stable-user-message",
      sessionId: "session-1",
      role: "user" as const,
      content: "question",
      threadKey: "root",
      metadata: { source: "web" },
    };
    await storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-1" },
      run: { runId: "run-original", sessionId: "session-1" },
      initialUserMessage: original,
    });

    const conflicts = [
      { ...original, content: "changed" },
      { ...original, role: "assistant" as const },
      { ...original, threadKey: "child:other" },
      { ...original, childAgentId: "child-other" },
      { ...original, metadata: { source: "feishu" } },
    ];
    for (const [index, initialUserMessage] of conflicts.entries()) {
      await expect(storage.operations.startRun({
        session: { sessionId: "session-1", userId: "user-1" },
        run: { runId: `run-conflict-${index}`, sessionId: "session-1" },
        initialUserMessage,
      })).rejects.toThrow("initial user message deterministic id conflict");
    }

    expect(store.listMessages("session-1").items).toEqual([
      expect.objectContaining({ id: "stable-user-message", role: "user", content: "question" }),
    ]);
    expect(store.listRuns("session-1").total).toBe(1);
  });

  it("rejects a deterministic message id already owned by another session", async () => {
    const { store, storage } = createHarness();
    await storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-1" },
      run: { runId: "run-1", sessionId: "session-1" },
      initialUserMessage: {
        messageId: "cross-session-message",
        sessionId: "session-1",
        role: "user",
        content: "question",
      },
    });

    await expect(storage.operations.startRun({
      session: { sessionId: "session-2", userId: "user-2" },
      run: { runId: "run-2", sessionId: "session-2" },
      initialUserMessage: {
        messageId: "cross-session-message",
        sessionId: "session-2",
        role: "user",
        content: "question",
      },
    })).rejects.toThrow("initial user message deterministic id conflict");

    expect(store.getSession("session-2")).toBeNull();
    expect(store.getRun("session-2", "run-2")).toBeNull();
    expect(store.listMessages("session-1").items).toHaveLength(1);
  });

  it("rejects an empty outbox event id before persisting a step", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);

    await expect(storage.operations.recordEnvelope({
      step: { sessionId: "session-1", runId: "run-1", stepType: "event", payload: {} },
      outbox: {
        eventId: "   ",
        sessionId: "session-1",
        runId: "run-1",
        eventType: "client.event",
        aggregateType: "run",
        aggregateId: "run-1",
        payload: {},
      },
    })).rejects.toThrow("stable eventId");

    expect(store.listRunSteps({ sessionId: "session-1", runId: "run-1" })).toEqual([]);
    expect(store.listOutboxForReplay({ sessionId: "session-1" })).toEqual([]);
  });

  it("returns the existing step and outbox when an event id is replayed", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    const input = {
      step: {
        sessionId: "session-1",
        runId: "run-1",
        stepType: "protocol.envelope.v1",
        payload: { type: "tool_call", call_id: "call-1" },
      },
      outbox: {
        eventId: "stable-event-1",
        sessionId: "session-1",
        runId: "run-1",
        eventType: "client.tool_call",
        aggregateType: "run",
        aggregateId: "run-1",
        payload: { client_event: { type: "tool_call", call_id: "call-1" } },
      },
    };

    const first = await storage.operations.recordEnvelope(input);
    const replay = await storage.operations.recordEnvelope(input);

    expect(replay).toEqual(first);
    expect(replay.step?.event_id).toBe("stable-event-1");
    expect(store.listRunSteps({ sessionId: "session-1", runId: "run-1" })).toHaveLength(1);
    expect(store.listOutboxForReplay({ sessionId: "session-1" })).toHaveLength(1);
  });

  it("rejects an event id replay with conflicting immutable outbox fields", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    const base = {
      step: { sessionId: "session-1", runId: "run-1", stepType: "event", payload: {} },
      outbox: {
        eventId: "conflicting-event",
        sessionId: "session-1",
        runId: "run-1",
        eventType: "client.event",
        aggregateType: "run",
        aggregateId: "run-1",
        payload: { value: 1 },
      },
    };
    await storage.operations.recordEnvelope(base);

    await expect(storage.operations.recordEnvelope({
      ...base,
      outbox: { ...base.outbox, payload: { value: 2 } },
    })).rejects.toThrow("outbox eventId conflict");

    expect(store.listRunSteps({ sessionId: "session-1", runId: "run-1" })).toHaveLength(1);
    expect(store.listOutboxForReplay({ sessionId: "session-1" })).toHaveLength(1);
  });

  it("rejects an event id replay with conflicting immutable step fields", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    const base = {
      step: { sessionId: "session-1", runId: "run-1", stepType: "event", payload: { value: 1 } },
      outbox: {
        eventId: "conflicting-step",
        sessionId: "session-1",
        runId: "run-1",
        eventType: "client.event",
        aggregateType: "run",
        aggregateId: "run-1",
        payload: { value: 1 },
      },
    };
    await storage.operations.recordEnvelope(base);

    await expect(storage.operations.recordEnvelope({
      ...base,
      step: { ...base.step, stepType: "other" },
    })).rejects.toThrow("run step eventId conflict");

    expect(store.listRunSteps({ sessionId: "session-1", runId: "run-1" })).toHaveLength(1);
    expect(store.listOutboxForReplay({ sessionId: "session-1" })).toHaveLength(1);
  });

  it("closes dangling tool calls atomically when a run is interrupted", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    await storage.operations.persistMessage({
      message: {
        messageId: "run-1:intent:0",
        sessionId: "session-1",
        role: "assistant",
        content: "working",
        threadKey: "root",
        toolCalls: [
          { id: "answered", type: "function", function: { name: "read", arguments: "{}" } },
          { id: "dangling", type: "function", function: { name: "write", arguments: "{}" } },
        ],
        metadata: { run_id: "run-1", round: 2 },
      },
    });
    await storage.operations.persistMessage({
      message: {
        messageId: "run-1:tool:answered",
        sessionId: "session-1",
        role: "tool",
        content: "done",
        threadKey: "root",
        toolCallId: "answered",
        name: "read",
      },
    });

    await storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "interrupted",
      closeDanglingToolCalls: { threadKey: "root", agentName: "agent-1" },
      finalMessage: {
        messageId: "run-1:interrupted",
        sessionId: "session-1",
        role: "assistant",
        content: "",
        threadKey: "root",
        metadata: { interrupted: true },
      },
    });

    expect(store.getMessageById("session-1", "run-1:tool:dangling")).toMatchObject({
      role: "tool",
      content: "工具执行被中断",
      tool_call_id: "dangling",
      name: "write",
      metadata: { interrupted: true, round: 2 },
    });
    expect(store.listMessages("session-1").items.filter((message) => message.tool_call_id === "answered")).toHaveLength(1);
  });

  it("allows running to reach one terminal status and only replays that same terminal", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    const completed = {
      runId: "run-1",
      sessionId: "session-1",
      status: "completed" as const,
      finalMessage: {
        messageId: "terminal-final",
        sessionId: "session-1",
        role: "assistant" as const,
        content: "answer",
      },
    };

    const first = await storage.operations.finalizeRun(completed);
    const replay = await storage.operations.finalizeRun(completed);
    expect(replay.finalMessage?.id).toBe(first.finalMessage?.id);
    expect(store.listMessages("session-1").items).toHaveLength(1);

    await expect(storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "failed",
    })).rejects.toThrow("run terminal status conflict");
    expect(store.getRun("session-1", "run-1")).toMatchObject({
      status: "completed",
      final_message_id: "terminal-final",
    });
  });

  it("enforces final-message policy before changing run state", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);

    await expect(storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "completed",
    })).rejects.toThrow("completed run requires a final message");
    for (const status of ["failed", "suspended"] as const) {
      await expect(storage.operations.finalizeRun({
        runId: "run-1",
        sessionId: "session-1",
        status,
        finalMessage: {
          messageId: `invalid-${status}-message`,
          sessionId: "session-1",
          role: "assistant",
          content: "invalid",
        },
      })).rejects.toThrow(`${status} run must not include a final message`);
    }

    expect(store.getRun("session-1", "run-1")?.status).toBe("running");
    expect(store.listMessages("session-1").items).toEqual([]);
  });

  it("rejects a suspended to completed terminal shortcut", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);
    await storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "suspended",
    });

    await expect(storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "completed",
      finalMessage: {
        messageId: "invalid-resume-final",
        sessionId: "session-1",
        role: "assistant",
        content: "must resume first",
      },
    })).rejects.toThrow("run terminal status conflict");

    expect(store.getMessageById("session-1", "invalid-resume-final")).toBeNull();
    expect(store.getRun("session-1", "run-1")?.status).toBe("suspended");
  });

  it("serializes concurrent atomic records without duplicate step or event sequence numbers", async () => {
    const { store, storage } = createHarness();
    await startRun(storage);

    await Promise.all(Array.from({ length: 20 }, (_, index) => storage.operations.recordEnvelope({
      step: {
        sessionId: "session-1",
        runId: "run-1",
        stepType: "event",
        payload: { index },
      },
      outbox: {
        eventId: `event-${index}`,
        sessionId: "session-1",
        runId: "run-1",
        eventType: "client.event",
        aggregateType: "run",
        aggregateId: "run-1",
        payload: { index },
      },
    })));

    expect(store.listRunSteps({ sessionId: "session-1", runId: "run-1", limit: 100 })
      .map((step) => step.step_order)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(store.listOutboxForReplay({ sessionId: "session-1", limit: 100 })
      .map((row) => row.session_seq)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
  });

  it("records and resolves a batch idempotently, allows one resume claim, and rolls it back by token", async () => {
    const { store, storage } = createHarness();
    await startInteractionRun(storage);
    const firstInteraction = interactionInput("interaction-1", "tool-1");
    const secondInteraction = interactionInput("interaction-2", "tool-2");

    const firstRecord = await storage.operations.recordInteraction({
      interaction: firstInteraction,
      rootCallId: "root-call-1",
      record: interactionRecord(firstInteraction, "required"),
    });
    const replayedRecord = await storage.operations.recordInteraction({
      interaction: firstInteraction,
      rootCallId: "root-call-1",
      record: interactionRecord(firstInteraction, "required"),
    });
    await storage.operations.recordInteraction({
      interaction: secondInteraction,
      rootCallId: "root-call-1",
      record: interactionRecord(secondInteraction, "required"),
    });

    expect(replayedRecord).toEqual(firstRecord);
    expect(store.listPendingInteractions({ sessionId: "session-1", batchId: "batch-1" }))
      .toHaveLength(2);
    expect(store.listOutboxForReplay({ sessionId: "session-1" })
      .filter((row) => row.event_id.endsWith(":required"))).toHaveLength(2);

    await storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "suspended",
      interactionRootRunId: "run-1",
    });
    const firstResolution = {
      sessionId: "session-1",
      interactionId: "interaction-1",
      resolution: { kind: "approval" as const, approved: true, message: "allow one" },
      buildRecord: () => interactionRecord(firstInteraction, "responded"),
    };
    const resolvedFirst = await storage.operations.resolveInteraction(firstResolution);
    const replayedFirst = await storage.operations.resolveInteraction(firstResolution);
    await expect(storage.operations.claimResume({
      sessionId: "session-1",
      interactionId: "interaction-1",
      claimId: "claim-too-early",
    })).resolves.toEqual({ claimed: false, reason: "batch_incomplete" });
    const resolvedSecond = await storage.operations.resolveInteraction({
      sessionId: "session-1",
      interactionId: "interaction-2",
      resolution: { kind: "approval", approved: false, message: "deny two" },
      buildRecord: () => interactionRecord(secondInteraction, "responded"),
    });

    expect(resolvedFirst).toMatchObject({ changed: true, batchReady: false, rootRunStatus: "suspended" });
    expect(replayedFirst).toMatchObject({ changed: false, batchReady: false, rootRunStatus: "suspended" });
    expect(resolvedSecond).toMatchObject({ changed: true, batchReady: true, rootRunStatus: "suspended" });
    expect(store.listOutboxForReplay({ sessionId: "session-1" })
      .filter((row) => row.event_id.endsWith(":responded"))).toHaveLength(2);
    await expect(storage.operations.resolveInteraction({
      ...firstResolution,
      resolution: { kind: "approval", approved: false, message: "conflict" },
    })).rejects.toThrow("resolution conflict");

    const claims = await Promise.all([
      storage.operations.claimResume({
        sessionId: "session-1",
        interactionId: "interaction-1",
        claimId: "claim-1",
      }),
      storage.operations.claimResume({
        sessionId: "session-1",
        interactionId: "interaction-2",
        claimId: "claim-2",
      }),
    ]);
    expect(claims.filter((result) => result.claimed)).toHaveLength(1);
    expect(claims.filter((result) => !result.claimed)).toEqual([
      { claimed: false, reason: "already_claimed" },
    ]);
    const claimed = claims.find((result) => result.claimed);
    expect(claimed).toMatchObject({
      claimed: true,
      batchId: "batch-1",
      rootRunId: "run-1",
      rootCallId: "root-call-1",
      agentName: "agent-1",
      task: "approve tools",
      requestId: "request-1",
      executionKind: "agent_stream",
      userId: "user-1",
      sessionMetadata: { source: "contract-test" },
      resolutions: expect.arrayContaining([
        expect.objectContaining({ interactionId: "interaction-1", toolCallId: "tool-1" }),
        expect.objectContaining({ interactionId: "interaction-2", toolCallId: "tool-2" }),
      ]),
    });

    await expect(storage.operations.rollbackResume({
      sessionId: "session-1",
      rootRunId: "run-1",
      claimId: "wrong-claim",
    })).resolves.toEqual({ rolledBack: false });
    expect(store.getRun("session-1", "run-1")?.status).toBe("running");
    await expect(storage.operations.rollbackResume({
      sessionId: "session-1",
      rootRunId: "run-1",
      claimId: claimed?.claimed ? claimed.claimId : "",
    })).resolves.toEqual({ rolledBack: true });
    expect(store.getRun("session-1", "run-1")?.status).toBe("suspended");
    expect(store.listPendingInteractions({ sessionId: "session-1", batchId: "batch-1" })
      .map((interaction) => [interaction.status, interaction.resume_claim_id])).toEqual([
      ["resolved", null],
      ["resolved", null],
    ]);
  });

  it("finalizes the root pending-interaction matrix atomically", async () => {
    const cases = [
      { status: "suspended" as const, expected: ["suspended", "consumed", "resolved", "resolved"], ready: ["resolved-1"] },
      { status: "completed" as const, expected: ["cancelled", "consumed", "consumed", "consumed"], ready: [] },
      { status: "failed" as const, expected: ["cancelled", "cancelled", "cancelled", "cancelled"], ready: [] },
      { status: "interrupted" as const, expected: ["cancelled", "cancelled", "cancelled", "cancelled"], ready: [] },
    ];
    for (const testCase of cases) {
      const { store, storage } = createHarness();
      await startInteractionRun(storage);
      const inputs = [
        interactionInput("waiting-1", "tool-waiting", "batch-waiting"),
        interactionInput("resuming-1", "tool-resuming", "batch-resuming"),
        interactionInput("resolved-1", "tool-resolved-1", "batch-resolved"),
        interactionInput("resolved-2", "tool-resolved-2", "batch-resolved"),
      ];
      for (const input of inputs) {
        await storage.operations.recordInteraction({ interaction: input, rootCallId: "root-call", record: interactionRecord(input, "required") });
      }
      for (const interactionId of ["resuming-1", "resolved-1", "resolved-2"]) {
        store.updatePendingInteractionStatus({
          sessionId: "session-1",
          interactionId,
          from: ["waiting"],
          status: "resolved",
          resolution: { approved: true, message: "ok" },
        });
      }
      store.updatePendingInteractionStatus({ sessionId: "session-1", interactionId: "resuming-1", from: ["resolved"], status: "resuming" });

      const result = await storage.operations.finalizeRun({
        runId: "run-1",
        sessionId: "session-1",
        status: testCase.status,
        interactionRootRunId: "run-1",
        ...(testCase.status === "completed" ? {
          finalMessage: { messageId: `final-${testCase.status}`, sessionId: "session-1", role: "assistant" as const, content: "done" },
        } : {}),
      });

      expect(store.listPendingInteractions({ sessionId: "session-1", rootRunId: "run-1" }).map((item) => item.status))
        .toEqual(testCase.expected);
      expect(result.readyResumeInteractionIds).toEqual(testCase.ready);
    }
  });

  it("rejects interaction finalization for a child run", async () => {
    const { storage } = createHarness();
    await storage.operations.startRun({
      session: { sessionId: "session-1", userId: "user-1" },
      run: { runId: "child-run", sessionId: "session-1", status: "running", parentRunId: "root-run" },
    });
    await expect(storage.operations.finalizeRun({
      runId: "child-run",
      sessionId: "session-1",
      status: "suspended",
      interactionRootRunId: "child-run",
    })).rejects.toThrow("root interaction finalization rejects a child run");
  });

  it("rolls pending interaction finalization back when terminal record building fails", async () => {
    const { store, storage } = createHarness();
    await startInteractionRun(storage);
    const waiting = interactionInput("rollback-waiting", "rollback-tool", "rollback-batch");
    await storage.operations.recordInteraction({ interaction: waiting, rootCallId: "root-call", record: interactionRecord(waiting, "required") });

    await expect(storage.operations.finalizeRun({
      runId: "run-1",
      sessionId: "session-1",
      status: "suspended",
      interactionRootRunId: "run-1",
      buildTerminalRecords: () => { throw new Error("terminal rollback sentinel"); },
    })).rejects.toThrow("terminal rollback sentinel");

    expect(store.getRun("session-1", "run-1")?.status).toBe("running");
    expect(store.getPendingInteraction("session-1", "rollback-waiting")?.status).toBe("waiting");
  });

  it("rolls back a new pending interaction when its stable event conflicts", async () => {
    const { store, storage } = createHarness();
    await startInteractionRun(storage);
    const interaction = interactionInput("interaction-conflict", "tool-conflict");
    const record = interactionRecord(interaction, "required");
    await storage.operations.recordEnvelope({
      outbox: { ...record.outbox, payload: { client_event: { type: "conflicting" } } },
    });

    await expect(storage.operations.recordInteraction({
      interaction,
      rootCallId: "root-call-1",
      record,
    })).rejects.toThrow("outbox eventId conflict");

    expect(store.getPendingInteraction("session-1", "interaction-conflict")).toBeNull();
    expect(store.listRunSteps({ sessionId: "session-1", runId: "run-1" })).toEqual([]);
    expect(store.listOutboxForReplay({ sessionId: "session-1" }))
      .toEqual([expect.objectContaining({ event_id: "interaction-conflict:required" })]);
  });

  it("rejects a pending batch that mixes root runs", async () => {
    const { store, storage } = createHarness();
    await startInteractionRun(storage);
    store.createPendingInteraction({
      interactionId: "foreign-root-interaction",
      sessionId: "session-1",
      runId: "run-1",
      rootRunId: "root-foreign",
      toolCallId: "tool-foreign",
      batchId: "batch-mixed",
      kind: "approval",
      requestPayload: { rootCallId: "root-call-foreign" },
    });
    const interaction = interactionInput("interaction-local", "tool-local", "batch-mixed");

    await expect(storage.operations.recordInteraction({
      interaction,
      rootCallId: "root-call-1",
      record: interactionRecord(interaction, "required"),
    })).rejects.toThrow("batch spans multiple root runs");

    expect(store.getPendingInteraction("session-1", "interaction-local")).toBeNull();
    store.createPendingInteraction(interaction);
    await expect(storage.operations.resolveInteraction({
      sessionId: "session-1",
      interactionId: "interaction-local",
      resolution: { kind: "approval", approved: true, message: "must reject" },
      buildRecord: () => interactionRecord(interaction, "responded"),
    })).rejects.toThrow("batch spans multiple root runs");
    expect(store.getPendingInteraction("session-1", "interaction-local")?.status).toBe("waiting");
    await expect(storage.operations.claimResume({
      sessionId: "session-1",
      interactionId: "interaction-local",
      claimId: "claim-mixed",
    })).rejects.toThrow("batch spans multiple root runs");
  });
});
