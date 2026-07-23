import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OutboxRow, RunInfo } from "../../src/contracts/conversation-store/index.js";
import type { MessageInfo, SessionInfo } from "../../src/contracts/session/session.js";
import type { RuntimeStorage } from "../../src/contracts/storage/runtime-storage.js";

export interface RuntimeStorageInspection {
  getSession(sessionId: string): Promise<SessionInfo | null>;
  getMessage(sessionId: string, messageId: string): Promise<MessageInfo | null>;
  listMessages(sessionId: string): Promise<MessageInfo[]>;
  getRun(sessionId: string, runId: string): Promise<RunInfo | null>;
  listRuns(sessionId: string): Promise<RunInfo[]>;
  listSteps(sessionId: string, runId: string): Promise<Array<{
    event_id?: string | null;
    step_order: number;
  }>>;
  listOutbox(sessionId: string): Promise<OutboxRow[]>;
}

export interface RuntimeStorageOutboxContract {
  claimPending(limit: number, now?: Date): Promise<OutboxRow[]>;
  markDelivered(id: number): Promise<boolean>;
}

export interface RuntimeStorageContractHarness {
  storage: RuntimeStorage;
  peerStorage: RuntimeStorage;
  inspection: RuntimeStorageInspection;
  outbox: RuntimeStorageOutboxContract;
  close(): Promise<void> | void;
}

export function runRuntimeStorageBehaviorContract(
  label: string,
  createHarness: () => Promise<RuntimeStorageContractHarness> | RuntimeStorageContractHarness,
): void {
  describe(`${label} RuntimeStorage behavior contract`, () => {
    let harness: RuntimeStorageContractHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness?.close();
    });

    it("starts a run and its initial message atomically and idempotently", async () => {
      const input = {
        ...startInput("session-1", "run-1", "message-1"),
        initialRecords: [envelopeInput("event-started", 1)],
      };

      const first = await harness.storage.operations.startRun(input);
      const replay = await harness.storage.operations.startRun(input);

      expect(replay).toEqual(first);
      await expect(harness.inspection.getSession("session-1")).resolves.toMatchObject({
        session_id: "session-1",
        user_id: "user-1",
      });
      await expect(harness.inspection.listMessages("session-1")).resolves.toEqual([
        expect.objectContaining({ id: "message-1", role: "user", content: "question" }),
      ]);
      await expect(harness.inspection.listRuns("session-1")).resolves.toEqual([
        expect.objectContaining({ run_id: "run-1", status: "running" }),
      ]);
      await expect(harness.inspection.listSteps("session-1", "run-1")).resolves.toEqual([
        expect.objectContaining({ event_id: "event-started", step_order: 1 }),
      ]);
      await expect(harness.inspection.listOutbox("session-1")).resolves.toEqual([
        expect.objectContaining({ event_id: "event-started", session_seq: 1 }),
      ]);
    });

    it("permits only one running root run per session", async () => {
      await harness.storage.operations.startOrAppendRoot(startOrAppendInput("session-fenced", "run-first", "message-first"));

      await expect(harness.storage.operations.startOrAppendRoot(
        startOrAppendInput("session-fenced", "run-second", "message-second"),
      )).resolves.toMatchObject({
        kind: "followup",
        activeRunId: "run-first",
        message: { id: "message-second", metadata: { run_id: "run-first", execution_kind: "session_followup" } },
      });
      await expect(harness.inspection.getMessage("session-fenced", "message-second")).resolves.toMatchObject({ metadata: { run_id: "run-first", execution_kind: "session_followup" } });
      await expect(harness.inspection.getRun("session-fenced", "run-second")).resolves.toBeNull();

      await harness.storage.operations.finalizeRun({ runId: "run-first", sessionId: "session-fenced", status: "interrupted" });
      await expect(harness.storage.operations.startOrAppendRoot(
        startOrAppendInput("session-fenced", "run-second", "message-third"),
      )).resolves.toMatchObject({ kind: "started", run: { run_id: "run-second", status: "running" } });
    });

    it("defers an active-root followup without persisting a message or event", async () => {
      await harness.storage.operations.startOrAppendRoot(
        startOrAppendInput("session-deferred", "run-first", "message-first"),
      );

      await expect(harness.storage.operations.startOrAppendRoot({
        ...startOrAppendInput("session-deferred", "run-second", "message-deferred"),
        deferFollowup: true,
      })).resolves.toEqual({ kind: "followup", activeRunId: "run-first" });

      await expect(harness.inspection.getMessage("session-deferred", "message-deferred")).resolves.toBeNull();
      await expect(harness.inspection.listMessages("session-deferred")).resolves.toEqual([
        expect.objectContaining({ id: "message-first", role: "user" }),
      ]);
      await expect(harness.inspection.getRun("session-deferred", "run-second")).resolves.toBeNull();
      await expect(harness.inspection.listOutbox("session-deferred")).resolves.toEqual([]);
    });

    it("grants the session root slot to only one concurrent storage instance", async () => {
      const [left, right] = await Promise.allSettled([
        harness.storage.operations.startOrAppendRoot(startOrAppendInput("session-concurrent", "run-left", "message-left")),
        harness.peerStorage.operations.startOrAppendRoot(startOrAppendInput("session-concurrent", "run-right", "message-right")),
      ]);
      const outcomes = [left, right];
      expect(outcomes.every((result) => result.status === "fulfilled")).toBe(true);
      expect(outcomes.filter((result) => result.status === "fulfilled" && result.value.kind === "started")).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === "fulfilled" && result.value.kind === "followup")).toHaveLength(1);
      await expect(harness.inspection.listRuns("session-concurrent")).resolves.toHaveLength(1);
      await expect(harness.inspection.listMessages("session-concurrent")).resolves.toHaveLength(2);
    });

    it("rolls back the new session and message when startRun conflicts", async () => {
      await harness.storage.operations.startRun(startInput("session-1", "shared-run", "message-1"));

      await expect(harness.storage.operations.startRun(
        {
          ...startInput("session-2", "shared-run", "message-must-rollback"),
          initialRecords: [envelopeInputFor("session-2", "shared-run", "event-must-rollback", 1)],
        },
      )).rejects.toThrow(/run scope conflict/);

      await expect(harness.inspection.getSession("session-2")).resolves.toBeNull();
      await expect(harness.inspection.getMessage("session-2", "message-must-rollback")).resolves.toBeNull();
      await expect(harness.inspection.listMessages("session-2")).resolves.toEqual([]);
      await expect(harness.inspection.listRuns("session-2")).resolves.toEqual([]);
      await expect(harness.inspection.listSteps("session-2", "shared-run")).resolves.toEqual([]);
      await expect(harness.inspection.listOutbox("session-2")).resolves.toEqual([]);
      await expect(harness.inspection.getRun("session-1", "shared-run")).resolves.toMatchObject({
        run_id: "shared-run",
      });
    });

    it("rolls back session, message, run, step, and outbox when an initial record conflicts", async () => {
      const input = {
        ...startInput("session-conflict", "run-conflict", "message-conflict"),
        initialRecords: [
          envelopeInputFor("session-conflict", "run-conflict", "event-conflict", 1),
          envelopeInputFor("session-conflict", "run-conflict", "event-conflict", 2),
        ],
      };

      await expect(harness.storage.operations.startRun(input)).rejects.toThrow(/conflict/);

      await expect(harness.inspection.getSession("session-conflict")).resolves.toBeNull();
      await expect(harness.inspection.getMessage("session-conflict", "message-conflict")).resolves.toBeNull();
      await expect(harness.inspection.getRun("session-conflict", "run-conflict")).resolves.toBeNull();
      await expect(harness.inspection.listSteps("session-conflict", "run-conflict")).resolves.toEqual([]);
      await expect(harness.inspection.listOutbox("session-conflict")).resolves.toEqual([]);
    });

    it("keeps message, run-step, and outbox ordering stable across event replay", async () => {
      await harness.storage.operations.startRun(startInput("session-1", "run-1", "message-1"));
      const first = envelopeInput("event-1", 1);
      const second = envelopeInput("event-2", 2);

      const firstResult = await harness.storage.operations.recordEnvelope(first);
      await harness.storage.operations.recordEnvelope(second);
      const replay = await harness.storage.operations.recordEnvelope(first);

      expect(replay).toEqual(firstResult);
      const messages = await harness.inspection.listMessages("session-1");
      const steps = await harness.inspection.listSteps("session-1", "run-1");
      const outbox = await harness.inspection.listOutbox("session-1");
      expect(messages).toHaveLength(1);
      expect(messages[0]?.seq).toBeGreaterThan(0);
      expect(steps).toEqual([
        expect.objectContaining({ event_id: "event-1", step_order: 1 }),
        expect.objectContaining({ event_id: "event-2", step_order: 2 }),
      ]);
      expect(outbox.map((row) => [row.event_id, row.session_seq])).toEqual([
        ["event-1", 1],
        ["event-2", 2],
      ]);
    });

    it("does not partially append a step or outbox row on deterministic event conflict", async () => {
      await harness.storage.operations.startRun(startInput("session-1", "run-1", "message-1"));
      await harness.storage.operations.recordEnvelope(envelopeInput("event-conflict", 1));

      await expect(harness.storage.operations.recordEnvelope(
        envelopeInput("event-conflict", 999),
      )).rejects.toThrow(/conflict/);

      await expect(harness.inspection.listSteps("session-1", "run-1")).resolves.toHaveLength(1);
      await expect(harness.inspection.listOutbox("session-1")).resolves.toHaveLength(1);
    });

    it("grants each pending outbox row to only one concurrent claimant", async () => {
      await harness.storage.operations.startRun(startInput("session-1", "run-1", "message-1"));
      await harness.storage.operations.recordEnvelope(envelopeInput("event-1", 1));
      await harness.storage.operations.recordEnvelope(envelopeInput("event-2", 2));

      const [left, right] = await Promise.all([
        harness.outbox.claimPending(10),
        harness.outbox.claimPending(10),
      ]);
      const leftIds = new Set(left.map((row) => row.id));
      const rightIds = new Set(right.map((row) => row.id));
      expect([...leftIds].filter((id) => rightIds.has(id))).toEqual([]);
      expect(new Set([...leftIds, ...rightIds]).size).toBe(2);

      for (const row of [...left, ...right]) {
        await expect(harness.outbox.markDelivered(row.id)).resolves.toBe(true);
      }
      await expect(harness.outbox.claimPending(10)).resolves.toEqual([]);
      expect((await harness.inspection.listOutbox("session-1")).map((row) => row.status))
        .toEqual(["delivered", "delivered"]);
    });
  });
}

function startInput(sessionId: string, runId: string, messageId: string) {
  return {
    session: {
      sessionId,
      userId: "user-1",
      metadata: { source: "runtime-storage-contract" },
    },
    run: {
      runId,
      sessionId,
      status: "running",
      agentName: "contract-agent",
      threadKey: "root",
      requestId: "request-1",
    },
    initialUserMessage: {
      messageId,
      sessionId,
      role: "user" as const,
      content: "question",
      threadKey: "root",
      metadata: { source: "runtime-storage-contract" },
    },
  };
}

function startOrAppendInput(sessionId: string, runId: string, messageId: string) {
  return {
    ...startInput(sessionId, runId, messageId),
    followupFactory: ({ activeRunId, roundIndex }: { activeRunId: string; roundIndex: number }) => ({
      message: { messageId, sessionId, role: "user" as const, content: "question", threadKey: "root", metadata: { run_id: activeRunId, execution_kind: "session_followup", source: "running_session", round_index: roundIndex } },
      recordFactory: () => [],
    }),
  };
}

function envelopeInput(eventId: string, marker: number) {
  return envelopeInputFor("session-1", "run-1", eventId, marker);
}

function envelopeInputFor(sessionId: string, runId: string, eventId: string, marker: number) {
  const event = {
    type: "stream_output",
    session_id: sessionId,
    run_id: runId,
    payload: { phase: "delta", content: `chunk-${marker}`, marker },
  };
  return {
    step: {
      sessionId,
      runId,
      stepType: "protocol.envelope.v1",
      payload: event,
    },
    outbox: {
      eventId,
      sessionId,
      runId,
      eventType: "client.stream_output",
      aggregateType: "run",
      aggregateId: runId,
      payload: { client_event: event },
    },
  };
}
