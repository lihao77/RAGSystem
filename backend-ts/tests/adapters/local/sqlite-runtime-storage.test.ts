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

describe("SqliteRuntimeStorage", () => {
  it("exposes only tenant identity and fixed atomic operations", () => {
    const { storage } = createHarness();

    expect(storage.tenantId).toBe(LOCAL_TENANT_ID);
    expect(storage.operations).toEqual({
      startRun: expect.any(Function),
      recordEnvelope: expect.any(Function),
      finalizeRun: expect.any(Function),
    });
    expect(storage).not.toHaveProperty("conversation");
    expect(storage).not.toHaveProperty("runs");
    expect(storage).not.toHaveProperty("outbox");
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
});
