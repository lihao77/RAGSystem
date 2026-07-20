import { isDeepStrictEqual } from "node:util";

import type { ConversationStore, ConversationStoreTransaction } from "../../contracts/conversation-store/index.js";
import { RuntimeInteractionUnavailableError } from "../../contracts/storage/runtime-storage.js";
import type {
  RuntimeAtomicOperations,
  RuntimeClaimResumeInput,
  RuntimeClaimResumeResult,
  RuntimeFinalizeRunInput,
  RuntimeFinalizeRunResult,
  RuntimeInteractionResolution,
  RuntimeInterruptSessionInput,
  RuntimeInterruptSessionResult,
  RuntimePersistMessageInput,
  RuntimePersistMessageResult,
  RuntimeRecordEnvelopeInput,
  RuntimeRecordEnvelopeResult,
  RuntimeRecordInteractionInput,
  RuntimeRecordInteractionResult,
  RuntimeRecoverExpiredResumeClaimsInput,
  RuntimeRecoverExpiredResumeClaimsResult,
  RuntimeRenewResumeClaimInput,
  RuntimeRenewResumeClaimResult,
  RuntimeResolveInteractionInput,
  RuntimeResolveInteractionResult,
  RuntimeRollbackResumeInput,
  RuntimeRollbackResumeResult,
  RuntimeStartRunInput,
  RuntimeStartRunResult,
  RuntimeStorage,
} from "../../contracts/storage/runtime-storage.js";
import { buildInterruptedToolMessages } from "../../contracts/storage/runtime-finalization.js";
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
      persistMessage: (input) => this.persistMessage(input),
      recordEnvelope: (input) => this.recordEnvelope(input),
      recordInteraction: (input) => this.recordInteraction(input),
      resolveInteraction: (input) => this.resolveInteraction(input),
      claimResume: (input) => this.claimResume(input),
      rollbackResume: (input) => this.rollbackResume(input),
      interruptSession: (input) => this.interruptSession(input),
      renewResumeClaim: (input) => this.renewResumeClaim(input),
      recoverExpiredResumeClaims: (input) => this.recoverExpiredResumeClaims(input),
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

  private persistMessage(input: RuntimePersistMessageInput): Promise<RuntimePersistMessageResult> {
    return this.serial.run(() => {
      assertContinuationScope(input);
      return this.store.runInTransaction((tx) => {
        const session = tx.getSession(input.message.sessionId);
        if (!session) throw new Error(`session not found: ${input.message.sessionId}`);
        if (session.tenant_id !== this.tenantId) {
          throw new Error(`session belongs to another tenant: ${input.message.sessionId}`);
        }
        const deletedProviderContinuations = input.deleteProviderContinuationThreadKey
          ? tx.deleteProviderContinuations(input.message.sessionId, input.deleteProviderContinuationThreadKey)
          : 0;
        const message = resolveDeterministicMessage(tx, input.message, "message");
        const providerContinuation = input.providerContinuation
          ? tx.putProviderContinuation(input.providerContinuation)
          : null;
        return { message, deletedProviderContinuations, providerContinuation };
      });
    });
  }

  private recordInteraction(input: RuntimeRecordInteractionInput): Promise<RuntimeRecordInteractionResult> {
    return this.serial.run(() => {
      const rootCallId = input.rootCallId.trim();
      if (!rootCallId) throw new Error("interaction requires a rootCallId");
      assertRecordScope(input.record, input.interaction.sessionId, input.interaction.runId);
      assertInteractionEnvelope(input.record, input.interaction, "required");
      const expected = {
        ...input.interaction,
        requestPayload: { ...input.interaction.requestPayload, rootCallId },
      };
      return this.store.runInTransaction((tx) => {
        assertTenantSession(tx, this.tenantId, expected.sessionId);
        assertRunBelongsToRoot(tx, expected.sessionId, expected.runId, expected.rootRunId);
        assertInteractionBatchRoot(tx.listPendingInteractions({
          sessionId: expected.sessionId,
          batchId: expected.batchId,
        }), expected.rootRunId);
        const existing = tx.getPendingInteraction(expected.sessionId, expected.interactionId);
        const interaction = existing ?? tx.createPendingInteraction(expected);
        assertInteractionIdentity(interaction, expected);
        return { interaction, record: recordEnvelope(tx, input.record) };
      });
    });
  }

  private resolveInteraction(input: RuntimeResolveInteractionInput): Promise<RuntimeResolveInteractionResult> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      assertTenantSession(tx, this.tenantId, input.sessionId);
      const current = tx.getPendingInteraction(input.sessionId, input.interactionId);
      if (!current) throw new RuntimeInteractionUnavailableError("not_found", input.interactionId);
      if (current.kind !== input.resolution.kind) {
        throw new RuntimeInteractionUnavailableError("kind_mismatch", input.interactionId);
      }
      if (current.status === "cancelled") {
        throw new RuntimeInteractionUnavailableError("cancelled", input.interactionId);
      }
      const record = input.buildRecord(current);
      assertRecordScope(record, input.sessionId, current.run_id);
      assertInteractionEnvelope(record, toCreatePendingInput(current), "responded");
      const resolution = resolutionPayload(input.resolution);
      if (current.resolution_payload && !isDeepStrictEqual(current.resolution_payload, resolution)) {
        throw new Error(`pending interaction resolution conflict: ${input.interactionId}`);
      }
      const previousStatus = current.status;
      let changed = false;
      if (current.status === "waiting" || current.status === "suspended") {
        changed = tx.updatePendingInteractionStatus({
          sessionId: input.sessionId,
          interactionId: input.interactionId,
          from: [current.status],
          status: "resolved",
          resolution,
        });
        if (!changed) throw new Error(`pending interaction resolution race: ${input.interactionId}`);
      } else if (!current.resolution_payload) {
        throw new Error(`pending interaction resolution missing: ${input.interactionId}`);
      }
      const interaction = tx.getPendingInteraction(input.sessionId, input.interactionId);
      if (!interaction) throw new Error(`pending interaction disappeared: ${input.interactionId}`);
      const batch = tx.listPendingInteractions({
        sessionId: input.sessionId,
        batchId: current.batch_id,
      });
      assertInteractionBatchRoot(batch, current.root_run_id);
      const batchReady = tx.listPendingInteractions({
        sessionId: input.sessionId,
        batchId: current.batch_id,
        statuses: ["waiting", "suspended"],
      }).length === 0;
      const rootRun = tx.getRun(input.sessionId, current.root_run_id);
      if (!rootRun) throw new Error(`interaction root run not found: ${current.root_run_id}`);
      return {
        interaction,
        previousStatus,
        changed,
        batchReady,
        rootRunStatus: rootRun.status,
        record: recordEnvelope(tx, record),
      };
    }));
  }

  private claimResume(input: RuntimeClaimResumeInput): Promise<RuntimeClaimResumeResult> {
    return this.serial.run(() => {
      const claimId = input.claimId.trim();
      if (!claimId) throw new Error("resume claimId must not be empty");
      return this.store.runInTransaction((tx): RuntimeClaimResumeResult => {
        const session = assertTenantSession(tx, this.tenantId, input.sessionId);
        const interaction = tx.getPendingInteraction(input.sessionId, input.interactionId);
        if (!interaction) return { claimed: false, reason: "not_found" };
        const batch = tx.listPendingInteractions({ sessionId: input.sessionId, batchId: interaction.batch_id });
        assertInteractionBatchRoot(batch, interaction.root_run_id);
        if (batch.some((item) => item.status === "waiting" || item.status === "suspended")) {
          return { claimed: false, reason: "batch_incomplete" };
        }
        if (batch.some((item) => item.status === "resuming" || item.resume_claim_id)) {
          return { claimed: false, reason: "already_claimed" };
        }
        if (batch.length === 0 || batch.some((item) => item.status !== "resolved")) {
          return { claimed: false, reason: "terminal" };
        }
        const rootRun = tx.getRun(input.sessionId, interaction.root_run_id);
        if (!rootRun) return { claimed: false, reason: "not_found" };
        if (rootRun.status !== "suspended") {
          const terminal = rootRun.status !== "running";
          return { claimed: false, reason: terminal ? "terminal" : "root_not_suspended" };
        }
        const claimed = tx.claimPendingBatch(input.sessionId, interaction.batch_id, claimId, resumeLeaseMs(input.leaseMs));
        if (claimed !== batch.length) {
          throw new Error(`resume batch claim was partial: ${interaction.batch_id}`);
        }
        if (!tx.updateRunStatus(rootRun.run_id, input.sessionId, "running", null)) {
          throw new Error(`resume root run update failed: ${rootRun.run_id}`);
        }
        const request = interaction.request_payload;
        if (!rootRun.agent_name) throw new Error(`resume root run has no agent: ${rootRun.run_id}`);
        return {
          claimed: true,
          claimId,
          batchId: interaction.batch_id,
          rootRunId: rootRun.run_id,
          rootCallId: stringField(request.rootCallId) ?? `call_${rootRun.run_id}`,
          agentName: rootRun.agent_name,
          task: stringField(request.task) ?? rootRun.task_summary ?? "",
          requestId: stringField(request.requestId) ?? rootRun.request_id,
          executionKind: stringField(request.executionKind) ?? rootRun.entrypoint ?? "agent_stream",
          userId: rootRun.user_id,
          sessionMetadata: session.metadata,
          resolutions: batch.map((item) => ({
            interactionId: item.interaction_id,
            toolCallId: item.tool_call_id,
            resolution: interactionResolution(item),
          })),
        };
      });
    });
  }

  private rollbackResume(input: RuntimeRollbackResumeInput): Promise<RuntimeRollbackResumeResult> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      assertTenantSession(tx, this.tenantId, input.sessionId);
      const claimed = tx.listPendingInteractions({ sessionId: input.sessionId, rootRunId: input.rootRunId })
        .filter((item) => item.status === "resuming" && item.resume_claim_id === input.claimId);
      if (claimed.length === 0) return { rolledBack: false };
      const rootRun = tx.getRun(input.sessionId, input.rootRunId);
      if (!rootRun || rootRun.status !== "running") return { rolledBack: false };
      const released = tx.releasePendingClaim(input.sessionId, input.rootRunId, input.claimId);
      if (released !== claimed.length) throw new Error(`resume claim rollback was partial: ${input.claimId}`);
      if (!tx.updateRunStatus(input.rootRunId, input.sessionId, "suspended", null)) {
        throw new Error(`resume root run rollback failed: ${input.rootRunId}`);
      }
      return { rolledBack: true };
    }));
  }

  private interruptSession(input: RuntimeInterruptSessionInput): Promise<RuntimeInterruptSessionResult> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      assertTenantSession(tx, this.tenantId, input.sessionId);
      const activeRuns = tx.listRuns(input.sessionId, 1000).items
        .filter((run) => run.status === "suspended")
        .sort((left, right) => left.run_id.localeCompare(right.run_id));
      const rootRunIds = new Set(activeRuns.filter((run) => run.parent_run_id === null).map((run) => run.run_id));
      for (const pending of tx.listPendingInteractions({
        sessionId: input.sessionId,
        statuses: ["waiting", "suspended", "resolved", "resuming"],
      })) {
        rootRunIds.add(pending.root_run_id);
      }
      const interruptedRuns: RuntimeInterruptSessionResult["interruptedRuns"] = [];
      const records: RuntimeRecordEnvelopeResult[] = [];
      let cancelledInteractions = 0;
      for (const rootRunId of [...rootRunIds].sort()) {
        const root = tx.getRun(input.sessionId, rootRunId);
        if (root && root.status !== "suspended") continue;
        cancelledInteractions += tx.listPendingInteractions({
          sessionId: input.sessionId,
          rootRunId,
          statuses: ["waiting", "suspended", "resolved", "resuming"],
        }).length;
        tx.finalizePendingInteractions(input.sessionId, rootRunId, "interrupted");
      }
      for (const run of activeRuns) {
        if (!tx.updateRunStatus(run.run_id, input.sessionId, "interrupted", null)) {
          throw new Error(`run not found while interrupting session: ${run.run_id}`);
        }
        const interrupted = { runId: run.run_id, parentRunId: run.parent_run_id };
        interruptedRuns.push(interrupted);
        if (run.parent_run_id === null) records.push(recordEnvelope(tx, input.buildRunEndedRecord(interrupted)));
      }
      return { interruptedRuns, cancelledInteractions, records };
    }));
  }

  private renewResumeClaim(input: RuntimeRenewResumeClaimInput): Promise<RuntimeRenewResumeClaimResult> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      assertTenantSession(tx, this.tenantId, input.sessionId);
      const renewed = tx.renewPendingClaim(input.sessionId, input.rootRunId, input.claimId, resumeLeaseMs(input.leaseMs));
      const record = tx.listPendingInteractions({ sessionId: input.sessionId, rootRunId: input.rootRunId })
        .find((item) => item.resume_claim_id === input.claimId && item.status === "resuming");
      return { renewed: renewed > 0, expiresAt: record?.resume_claim_expires_at ?? null };
    }));
  }

  private recoverExpiredResumeClaims(input: RuntimeRecoverExpiredResumeClaimsInput): Promise<RuntimeRecoverExpiredResumeClaimsResult> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      assertTenantSession(tx, this.tenantId, input.sessionId);
      const nowMs = Date.parse(input.now ?? new Date().toISOString());
      if (!Number.isFinite(nowMs)) throw new Error("resume claim now must be a valid timestamp");
      const candidates = tx.listPendingInteractions({ sessionId: input.sessionId, statuses: ["resuming"] })
        .filter((item) => item.resume_claim_id && item.resume_claim_expires_at && Date.parse(item.resume_claim_expires_at) <= nowMs);
      const groups = new Map<string, Array<{ rootRunId: string; batchId: string; claimId: string; interactionId: string }>>();
      for (const item of candidates) {
        const key = `${item.root_run_id}:${item.batch_id}:${item.resume_claim_id}`;
        const group = groups.get(key) ?? [];
        group.push({ rootRunId: item.root_run_id, batchId: item.batch_id, claimId: item.resume_claim_id!, interactionId: item.interaction_id });
        groups.set(key, group);
      }
      const recoveredClaimIds = new Set<string>();
      const recoveredBatchIds = new Set<string>();
      const suspendedRootRunIds = new Set<string>();
      for (const group of [...groups.values()].sort((left, right) => left[0]!.rootRunId.localeCompare(right[0]!.rootRunId) || left[0]!.batchId.localeCompare(right[0]!.batchId))) {
        const root = tx.getRun(input.sessionId, group[0]!.rootRunId);
        if (!root) continue;
        if (root.status !== "running") {
          if (root.status === "completed" || root.status === "failed" || root.status === "interrupted" || root.status === "suspended") {
            tx.finalizePendingInteractions(input.sessionId, group[0]!.rootRunId, root.status);
            recoveredClaimIds.add(group[0]!.claimId);
            recoveredBatchIds.add(group[0]!.batchId);
          }
          continue;
        }
        const released = tx.releasePendingClaim(input.sessionId, group[0]!.rootRunId, group[0]!.claimId);
        if (released !== group.length) throw new Error(`resume claim recovery was partial: ${group[0]!.claimId}`);
        recoveredClaimIds.add(group[0]!.claimId);
        recoveredBatchIds.add(group[0]!.batchId);
        suspendedRootRunIds.add(group[0]!.rootRunId);
      }
      for (const rootRunId of [...suspendedRootRunIds].sort()) {
        if (!tx.updateRunStatus(rootRunId, input.sessionId, "suspended", null)) {
          throw new Error(`resume root run recovery failed: ${rootRunId}`);
        }
      }
      return {
        recoveredClaimIds: [...recoveredClaimIds].sort(),
        recoveredBatchIds: [...recoveredBatchIds].sort(),
        suspendedRootRunIds: [...suspendedRootRunIds].sort(),
      };
    }));
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
        if (input.interactionRootRunId && input.interactionRootRunId !== input.runId) {
          throw new Error(`root interaction finalization requires the root run: ${input.runId}`);
        }
        if (input.interactionRootRunId && currentRun.parent_run_id !== null) {
          throw new Error(`root interaction finalization rejects a child run: ${input.runId}`);
        }
        const replayingTerminal = currentRun.status === input.status;
        if (currentRun.status !== "running" && !replayingTerminal) {
          throw new Error(
            `run terminal status conflict: expected running or ${input.status}, received ${currentRun.status}`,
          );
        }
        if (input.deleteProviderContinuationThreadKey) {
          tx.deleteProviderContinuations(input.sessionId, input.deleteProviderContinuationThreadKey);
        }
        const readyResumeInteractionIds = input.interactionRootRunId
          ? tx.finalizePendingInteractions(input.sessionId, input.interactionRootRunId, input.status)
          : [];
        if (input.closeDanglingToolCalls) {
          const messages = tx.getRecentMessages(
            input.sessionId,
            1000,
            input.closeDanglingToolCalls.threadKey,
          );
          for (const message of buildInterruptedToolMessages(messages, {
            sessionId: input.sessionId,
            runId: input.runId,
            ...input.closeDanglingToolCalls,
          })) {
            resolveDeterministicMessage(tx, message, "interrupted tool message");
          }
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
        return { finalMessage, records, readyResumeInteractionIds };
      });
    });
  }
}

function recordEnvelope(
  tx: ConversationStoreTransaction,
  input: RuntimeRecordEnvelopeInput,
): RuntimeRecordEnvelopeResult {
  if (!input.outbox.eventId?.trim()) throw new Error("execution outbox requires a stable eventId");
  const existingStep = tx.getRunStepByEventId(input.outbox.eventId);
  if (existingStep) {
    if (!input.step) throw new Error(`incomplete execution event record: ${input.outbox.eventId}`);
    const conflicts = existingStep.session_id !== input.step.sessionId
      || existingStep.run_id !== input.step.runId
      || existingStep.step_type !== input.step.stepType
      || !isDeepStrictEqual(existingStep.payload, input.step.payload);
    if (conflicts) throw new Error(`run step eventId conflict: ${input.outbox.eventId}`);
  }
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

function assertContinuationScope(input: RuntimePersistMessageInput): void {
  const continuation = input.providerContinuation;
  if (!continuation) return;
  if (continuation.messageId !== input.message.messageId) {
    throw new Error("provider continuation message mismatch");
  }
  if (continuation.sessionId !== input.message.sessionId) {
    throw new Error("provider continuation session mismatch");
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

function assertTenantSession(
  tx: ConversationStoreTransaction,
  tenantId: TenantId,
  sessionId: string,
) {
  const session = tx.getSession(sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.tenant_id !== tenantId) throw new Error(`session belongs to another tenant: ${sessionId}`);
  return session;
}

function assertRunBelongsToRoot(
  tx: ConversationStoreTransaction,
  sessionId: string,
  runId: string,
  rootRunId: string,
): void {
  let run = tx.getRun(sessionId, runId);
  if (!run) throw new Error(`interaction run not found: ${runId}`);
  const visited = new Set<string>();
  while (run.run_id !== rootRunId) {
    if (!run.parent_run_id || visited.has(run.run_id)) {
      throw new Error(`interaction run is outside root tree: ${runId} -> ${rootRunId}`);
    }
    visited.add(run.run_id);
    run = tx.getRun(sessionId, run.parent_run_id);
    if (!run) throw new Error(`interaction parent run not found: ${runId}`);
  }
  if (run.parent_run_id !== null) throw new Error(`interaction root run is not a root: ${rootRunId}`);
}

function assertInteractionIdentity(
  existing: import("../../contracts/conversation-store/index.js").PendingInteractionRecord,
  input: import("../../contracts/conversation-store/index.js").CreatePendingInteractionInput,
): void {
  const conflicts = existing.session_id !== input.sessionId
    || existing.run_id !== input.runId
    || existing.root_run_id !== input.rootRunId
    || existing.tool_call_id !== input.toolCallId
    || existing.batch_id !== input.batchId
    || existing.kind !== input.kind
    || !isDeepStrictEqual(existing.request_payload, input.requestPayload);
  if (conflicts) throw new Error(`pending interaction identity conflict: ${input.interactionId}`);
}

function assertInteractionEnvelope(
  record: RuntimeRecordEnvelopeInput,
  interaction: import("../../contracts/conversation-store/index.js").CreatePendingInteractionInput,
  phase: "required" | "responded",
): void {
  const expectedEventId = `${interaction.interactionId}:${phase}`;
  const outer = asRecord(record.outbox.payload);
  const event = asRecord(outer.client_event);
  const payload = asRecord(event.payload);
  if (record.outbox.eventId !== expectedEventId
    || record.outbox.eventType !== "client.interaction"
    || event.type !== "interaction"
    || event.session_id !== interaction.sessionId
    || event.run_id !== interaction.runId
    || event.call_id !== interaction.interactionId
    || payload.kind !== interaction.kind
    || payload.phase !== phase) {
    throw new Error(`interaction ${phase} envelope scope conflict: ${interaction.interactionId}`);
  }
}

function toCreatePendingInput(
  record: import("../../contracts/conversation-store/index.js").PendingInteractionRecord,
): import("../../contracts/conversation-store/index.js").CreatePendingInteractionInput {
  return {
    interactionId: record.interaction_id,
    sessionId: record.session_id,
    runId: record.run_id,
    rootRunId: record.root_run_id,
    toolCallId: record.tool_call_id,
    batchId: record.batch_id,
    kind: record.kind,
    requestPayload: record.request_payload,
  };
}

function resolutionPayload(resolution: RuntimeInteractionResolution): Record<string, unknown> {
  return resolution.kind === "approval"
    ? { approved: resolution.approved, message: resolution.message }
    : { value: resolution.value };
}

function interactionResolution(
  record: import("../../contracts/conversation-store/index.js").PendingInteractionRecord,
): RuntimeInteractionResolution {
  const payload = record.resolution_payload;
  if (!payload) throw new Error(`pending interaction resolution missing: ${record.interaction_id}`);
  if (record.kind === "user_input") {
    if (typeof payload.value !== "string") {
      throw new Error(`pending user input resolution is invalid: ${record.interaction_id}`);
    }
    return { kind: "user_input", value: payload.value };
  }
  if (typeof payload.approved !== "boolean" || typeof payload.message !== "string") {
    throw new Error(`pending approval resolution is invalid: ${record.interaction_id}`);
  }
  return { kind: "approval", approved: payload.approved, message: payload.message };
}

function assertInteractionBatchRoot(
  batch: readonly import("../../contracts/conversation-store/index.js").PendingInteractionRecord[],
  rootRunId: string,
): void {
  if (batch.some((item) => item.root_run_id !== rootRunId)) {
    throw new Error(`pending interaction batch spans multiple root runs: ${batch[0]?.batch_id ?? "unknown"}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resumeLeaseMs(value: number | undefined): number {
  const leaseMs = value ?? 120_000;
  if (!Number.isFinite(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) {
    throw new Error("resume leaseMs must be between 1 and 86400000 milliseconds");
  }
  return Math.trunc(leaseMs);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}
