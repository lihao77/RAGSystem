import { isDeepStrictEqual } from "node:util";

import type { ConversationStore, ConversationStoreTransaction } from "../../contracts/conversation-store/index.js";
import type {
  RuntimeAtomicOperations,
  RuntimeFinalizeRunInput,
  RuntimeFinalizeRunResult,
  RuntimeRecordEnvelopeInput,
  RuntimeRecordEnvelopeResult,
  RuntimeStartRunInput,
  RuntimeStartRunResult,
  RuntimeStorage,
} from "../../contracts/storage/runtime-storage.js";
import type { TenantId } from "../../identity/types.js";

class SerialExecutor {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Tenant-bound RuntimeStorage adapter over the synchronous SQLite ConversationStore. */
export class SqliteRuntimeStorage implements RuntimeStorage {
  readonly operations: RuntimeAtomicOperations;

  private readonly serial = new SerialExecutor();

  constructor(
    readonly tenantId: TenantId,
    private readonly store: ConversationStore,
  ) {
    this.operations = {
      startRun: (input) => this.startRun(input),
      recordEnvelope: (input) => this.recordEnvelope(input),
      finalizeRun: (input) => this.finalizeRun(input),
    };
  }

  private startRun(input: RuntimeStartRunInput): Promise<RuntimeStartRunResult> {
    return this.serial.run(() => {
      assertSessionId(input.run.sessionId, input.session.sessionId, "run");
      if (input.initialUserMessage) {
        assertSessionId(input.initialUserMessage.sessionId, input.session.sessionId, "initial user message");
      }
      return this.store.runInTransaction((tx) => {
        const existingSession = tx.getSession(input.session.sessionId);
        if (existingSession && existingSession.tenant_id !== this.tenantId) {
          throw new Error(`session belongs to another tenant: ${input.session.sessionId}`);
        }
        if (!existingSession) {
          tx.createSession(
            this.tenantId,
            input.session.sessionId,
            input.session.userId,
            input.session.metadata,
            input.session.permissionMode,
          );
        }
        const initialUserMessage = input.initialUserMessage
          ? resolveDeterministicMessage(tx, input.initialUserMessage, "initial user message")
          : null;
        const existingRun = tx.getRun(input.session.sessionId, input.run.runId);
        let run: RuntimeStartRunResult["run"];
        if (existingRun) {
          assertRunScope(existingRun, input.run, this.tenantId);
          run = toCreatedRun(existingRun);
        } else {
          try {
            run = tx.createRun(input.run);
          } catch (error) {
            throw new Error(`run scope conflict: ${input.run.runId}`, { cause: error });
          }
        }
        return { run, initialUserMessage };
      });
    });
  }

  private recordEnvelope(input: RuntimeRecordEnvelopeInput): Promise<RuntimeRecordEnvelopeResult> {
    return this.serial.run(() => {
      assertRecordScope(input);
      return this.store.runInTransaction((tx) => recordEnvelope(tx, input));
    });
  }

  private finalizeRun(input: RuntimeFinalizeRunInput): Promise<RuntimeFinalizeRunResult> {
    return this.serial.run(() => {
      assertFinalizeMessagePolicy(input);
      if (input.finalMessage) {
        assertSessionId(input.finalMessage.sessionId, input.sessionId, "final message");
        if (!input.finalMessage.messageId) throw new Error("final message requires a stable messageId");
      }
      return this.store.runInTransaction((tx) => {
        const currentRun = tx.getRun(input.sessionId, input.runId);
        if (!currentRun) throw new Error(`run not found while finalizing: ${input.runId}`);
        const replayingTerminal = currentRun.status === input.status;
        if (currentRun.status !== "running" && !replayingTerminal) {
          throw new Error(
            `run terminal status conflict: expected running or ${input.status}, received ${currentRun.status}`,
          );
        }
        if (input.deleteProviderContinuationThreadKey) {
          tx.deleteProviderContinuations(input.sessionId, input.deleteProviderContinuationThreadKey);
        }
        if (input.suspendRootRunId) {
          tx.suspendPendingInteractions(input.sessionId, input.suspendRootRunId);
        }
        const finalMessage = resolveFinalMessage(tx, input, currentRun, replayingTerminal);
        const records: RuntimeRecordEnvelopeResult[] = [];
        for (const terminalRecord of input.buildTerminalRecords?.(finalMessage) ?? []) {
          assertRecordScope(terminalRecord, input.sessionId, input.runId);
          records.push(recordEnvelope(tx, terminalRecord));
        }
        if (finalMessage && input.attachStepsToFinalMessage !== false) {
          tx.updateRunStepsMessageId(input.sessionId, input.runId, finalMessage.id);
        }
        const updated = tx.updateRunStatus(
          input.runId,
          input.sessionId,
          input.status,
          finalMessage?.id ?? null,
        );
        if (!updated) throw new Error(`run not found while finalizing: ${input.runId}`);
        return { finalMessage, records };
      });
    });
  }
}

function recordEnvelope(
  tx: ConversationStoreTransaction,
  input: RuntimeRecordEnvelopeInput,
): RuntimeRecordEnvelopeResult {
  if (!input.outbox.eventId?.trim()) throw new Error("execution outbox requires a stable eventId");
  const step = input.step ? tx.addRunStep({ ...input.step, eventId: input.outbox.eventId }) : null;
  const outbox = tx.appendOutbox(input.outbox);
  return { step, outbox };
}

function assertRecordScope(
  input: RuntimeRecordEnvelopeInput,
  expectedSessionId?: string,
  expectedRunId?: string,
): void {
  if (expectedSessionId) assertSessionId(input.outbox.sessionId, expectedSessionId, "terminal outbox");
  if (expectedRunId && input.outbox.runId !== expectedRunId) {
    throw new Error(
      `terminal outbox run mismatch: expected ${expectedRunId}, received ${String(input.outbox.runId)}`,
    );
  }
  if (!input.step) return;
  assertSessionId(input.step.sessionId, expectedSessionId ?? input.outbox.sessionId, "run step");
  if (input.outbox.runId !== input.step.runId) {
    throw new Error(
      `execution record run mismatch: step ${input.step.runId}, outbox ${String(input.outbox.runId)}`,
    );
  }
}

function assertSessionId(actual: string, expected: string, subject: string): void {
  if (actual !== expected) {
    throw new Error(`${subject} session mismatch: expected ${expected}, received ${actual}`);
  }
}

function assertFinalizeMessagePolicy(input: RuntimeFinalizeRunInput): void {
  if (input.status === "completed" && !input.finalMessage) {
    throw new Error("completed run requires a final message");
  }
  if ((input.status === "failed" || input.status === "suspended") && input.finalMessage) {
    throw new Error(`${input.status} run must not include a final message`);
  }
}

function resolveFinalMessage(
  tx: ConversationStoreTransaction,
  input: RuntimeFinalizeRunInput,
  currentRun: import("../../contracts/conversation-store/index.js").RunInfo,
  replayingTerminal: boolean,
) {
  if (replayingTerminal) {
    const persisted = currentRun.final_message_id
      ? tx.getMessageById(input.sessionId, currentRun.final_message_id)
      : null;
    if (currentRun.final_message_id && !persisted) {
      throw new Error(`run final message missing: ${currentRun.final_message_id}`);
    }
    if (input.finalMessage) {
      if (currentRun.final_message_id !== input.finalMessage.messageId) {
        throw new Error(
          `run final message conflict: expected ${String(currentRun.final_message_id)}, received ${input.finalMessage.messageId}`,
        );
      }
      if (!persisted) throw new Error(`run final message conflict: ${input.finalMessage.messageId}`);
      assertMessageMatches(persisted, input.finalMessage, "final message");
    }
    return persisted;
  }
  return input.finalMessage
    ? resolveDeterministicMessage(tx, input.finalMessage, "final message")
    : null;
}

function resolveDeterministicMessage(
  tx: ConversationStoreTransaction,
  input: import("../../contracts/conversation-store/index.js").AddMessageInput & { messageId: string },
  subject: string,
) {
  const existing = tx.getMessageById(input.sessionId, input.messageId);
  if (existing) {
    assertMessageMatches(existing, input, subject);
    return existing;
  }
  try {
    return tx.addMessage(input);
  } catch (error) {
    throw new Error(`${subject} deterministic id conflict: ${input.messageId}`, { cause: error });
  }
}

function assertMessageMatches(
  existing: import("../../contracts/session/session.js").MessageInfo,
  input: import("../../contracts/conversation-store/index.js").AddMessageInput & { messageId: string },
  subject: string,
): void {
  const expectedThreadKey = input.threadKey?.trim()
    || (typeof input.metadata?.thread_key === "string" ? input.metadata.thread_key.trim() : "")
    || "root";
  const expectedChildAgentId = input.childAgentId
    ?? (typeof input.metadata?.child_agent_id === "string" ? input.metadata.child_agent_id : null);
  const mismatched = existing.session_id !== input.sessionId
    || existing.role !== input.role
    || existing.content !== input.content
    || existing.thread_key !== expectedThreadKey
    || existing.child_agent_id !== expectedChildAgentId
    || (existing.tool_call_id ?? null) !== (input.toolCallId ?? null)
    || (existing.name ?? null) !== (input.name ?? null)
    || !sameJson(existing.tool_calls ?? null, input.toolCalls ?? null)
    || Object.entries(input.metadata ?? {}).some(([key, value]) => !sameJson(existing.metadata[key], value));
  if (mismatched) throw new Error(`${subject} deterministic id conflict: ${input.messageId}`);
}

function assertRunScope(
  existing: import("../../contracts/conversation-store/index.js").RunInfo,
  input: RuntimeStartRunInput["run"],
  tenantId: TenantId,
): void {
  const threadKey = input.threadKey?.trim() || "root";
  if (existing.tenant_id !== tenantId
    || existing.session_id !== input.sessionId
    || existing.thread_key !== threadKey
    || existing.parent_run_id !== (input.parentRunId ?? null)
    || existing.parent_call_id !== (input.parentCallId ?? null)
    || existing.child_agent_id !== (input.childAgentId ?? null)
    || existing.agent_name !== (input.agentName ?? null)) {
    throw new Error(`run scope conflict: ${input.runId}`);
  }
}

function toCreatedRun(
  run: import("../../contracts/conversation-store/index.js").RunInfo,
): RuntimeStartRunResult["run"] {
  return {
    run_id: run.run_id,
    session_id: run.session_id,
    status: run.status,
    thread_key: run.thread_key,
    parent_run_id: run.parent_run_id,
    parent_call_id: run.parent_call_id,
    child_agent_id: run.child_agent_id,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
