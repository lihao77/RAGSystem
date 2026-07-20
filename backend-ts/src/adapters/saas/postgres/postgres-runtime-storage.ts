import { isDeepStrictEqual } from "node:util";

import type {
  RuntimeAtomicOperations,
  RuntimeClaimResumeInput,
  RuntimeClaimResumeResult,
  RuntimeConversationStorage,
  RuntimeFinalizeRunInput,
  RuntimeFinalizeRunResult,
  RuntimeInteractionResolution,
  RuntimePersistMessageInput,
  RuntimePersistMessageResult,
  RuntimeOutboxStorage,
  RuntimePendingInteractionStorage,
  RuntimeProviderContinuationStorage,
  RuntimeRecordEnvelopeInput,
  RuntimeRecordEnvelopeResult,
  RuntimeRecordInteractionInput,
  RuntimeRecordInteractionResult,
  RuntimeResolveInteractionInput,
  RuntimeResolveInteractionResult,
  RuntimeRollbackResumeInput,
  RuntimeRollbackResumeResult,
  RuntimeRunStorage,
  RuntimeStartRunInput,
  RuntimeStartRunResult,
  RuntimeStorage,
  RuntimeStorageRepositories,
} from "../../../contracts/storage/runtime-storage.js";
import type { TenantId } from "../../../identity/types.js";
import type {
  AddMessageInput,
  CreatePendingInteractionInput,
  OutboxRow,
  PendingInteractionRecord,
  RunInfo,
  RunStepRecord,
} from "../../../contracts/conversation-store/index.js";
import type { MessageInfo } from "../../../contracts/session/session.js";
import { buildInterruptedToolMessages } from "../../../contracts/storage/runtime-finalization.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { PostgresConversationRepository } from "./conversation-repository.js";
import { PostgresOutboxRepository } from "./outbox-repository.js";
import { PostgresPendingInteractionRepository } from "./pending-interaction-repository.js";
import { PostgresProviderContinuationRepository } from "./provider-continuation-repository.js";
import { PostgresRunRepository } from "./run-repository.js";

function createTransactionFacade(
  tenantId: TenantId,
  executor: PostgresMemoryExecutor,
): RuntimeStorageRepositories {
  const conversationRepository = new PostgresConversationRepository(executor);
  const runRepository = new PostgresRunRepository(executor);
  const outboxRepository = new PostgresOutboxRepository(executor);
  const pendingInteractionRepository = new PostgresPendingInteractionRepository(executor);
  const providerContinuationRepository = new PostgresProviderContinuationRepository(executor);

  const conversation: RuntimeConversationStorage = {
    createSession: (sessionId, userId, metadata, permissionMode) => conversationRepository.createSession(
      tenantId,
      sessionId,
      userId,
      metadata,
      permissionMode,
    ),
    getSession: conversationRepository.getSession.bind(conversationRepository),
    updateSessionMetadata: conversationRepository.updateSessionMetadata.bind(conversationRepository),
    updateSessionPermissionMode: conversationRepository.updateSessionPermissionMode.bind(conversationRepository),
    addMessage: conversationRepository.addMessage.bind(conversationRepository),
    getMessageById: conversationRepository.getMessageById.bind(conversationRepository),
    getRecentMessages: conversationRepository.getRecentMessages.bind(conversationRepository),
    insertCompressionMessage: conversationRepository.insertCompressionMessage.bind(conversationRepository),
  };

  const runs: RuntimeRunStorage = {
    createRun: (input) => runRepository.createRun({ ...input, tenantId }),
    updateRunStatus: (runId, sessionId, status, finalMessageId) => runRepository.updateRunStatus(
      tenantId,
      runId,
      sessionId,
      status,
      finalMessageId,
    ),
    getRun: (sessionId, runId) => runRepository.getRun(tenantId, sessionId, runId),
    addRunStep: (input) => runRepository.addRunStep({ ...input, tenantId }),
    updateRunStepsMessageId: (sessionId, runId, messageId) => runRepository.updateRunStepsMessageId(
      tenantId,
      sessionId,
      runId,
      messageId,
    ),
  };

  const outbox: RuntimeOutboxStorage = {
    appendOutbox: outboxRepository.appendOutbox.bind(outboxRepository),
    listOutboxForReplay: (input) => outboxRepository.listOutboxForReplay({ tenantId, ...input }),
  };

  const pendingInteractions: RuntimePendingInteractionStorage = {
    createPendingInteraction: pendingInteractionRepository.createPendingInteraction.bind(pendingInteractionRepository),
    getPendingInteraction: pendingInteractionRepository.getPendingInteraction.bind(pendingInteractionRepository),
    listPendingInteractions: pendingInteractionRepository.listPendingInteractions.bind(pendingInteractionRepository),
    updatePendingInteractionStatus: pendingInteractionRepository.updatePendingInteractionStatus.bind(pendingInteractionRepository),
    markPendingBatchResuming: pendingInteractionRepository.markPendingBatchResuming.bind(pendingInteractionRepository),
    releasePendingBatch: pendingInteractionRepository.releasePendingBatch.bind(pendingInteractionRepository),
    suspendPendingInteractions: pendingInteractionRepository.suspendPendingInteractions.bind(pendingInteractionRepository),
    consumePendingResolution: pendingInteractionRepository.consumePendingResolution.bind(pendingInteractionRepository),
    cancelPendingInteractions: pendingInteractionRepository.cancelPendingInteractions.bind(pendingInteractionRepository),
  };

  const providerContinuations: RuntimeProviderContinuationStorage = {
    putProviderContinuation: (input) => providerContinuationRepository.putProviderContinuation(tenantId, input),
    getProviderContinuation: (sessionId, messageId) => providerContinuationRepository.getProviderContinuation(
      tenantId,
      sessionId,
      messageId,
    ),
    deleteProviderContinuations: (sessionId, threadKey) => providerContinuationRepository.deleteProviderContinuations(
      tenantId,
      sessionId,
      threadKey,
    ),
  };

  return { conversation, runs, outbox, pendingInteractions, providerContinuations };
}

export class PostgresRuntimeStorage implements RuntimeStorage {
  readonly operations: RuntimeAtomicOperations;

  constructor(
    readonly tenantId: TenantId,
    private readonly executor: PostgresMemoryExecutor,
  ) {
    this.operations = {
      startRun: (input) => this.startRun(input),
      persistMessage: (input) => this.persistMessage(input),
      recordEnvelope: (input) => this.recordEnvelope(input),
      recordInteraction: (input) => this.recordInteraction(input),
      resolveInteraction: (input) => this.resolveInteraction(input),
      claimResume: (input) => this.claimResume(input),
      rollbackResume: (input) => this.rollbackResume(input),
      finalizeRun: (input) => this.finalizeRun(input),
    };
  }

  private async startRun(input: RuntimeStartRunInput): Promise<RuntimeStartRunResult> {
    assertSessionId(input.run.sessionId, input.session.sessionId, "run");
    if (input.initialUserMessage) {
      assertSessionId(input.initialUserMessage.sessionId, input.session.sessionId, "initial user message");
    }
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session:${input.session.sessionId}`);
      const sessionExists = await assertTenantSession(
        transactionExecutor,
        this.tenantId,
        input.session.sessionId,
        true,
      );
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      if (!sessionExists) {
        await tx.conversation.createSession(
          input.session.sessionId,
          input.session.userId,
          input.session.metadata,
          input.session.permissionMode,
        );
      }
      await lockAdvisoryKey(transactionExecutor, `run:${this.tenantId}:${input.run.runId}`);
      const existingRun = await lockTenantRun(transactionExecutor, this.tenantId, input.run.runId);
      if (existingRun) assertRunScope(existingRun, input.run);
      let initialUserMessage = null;
      if (input.initialUserMessage) {
        initialUserMessage = await getOrCreateMessage(
          transactionExecutor,
          tx,
          input.initialUserMessage,
          "initial user message",
        );
      }
      const run = existingRun ? toCreatedRun(existingRun) : await tx.runs.createRun(input.run);
      return { run, initialUserMessage };
    });
  }

  private async recordEnvelope(input: RuntimeRecordEnvelopeInput): Promise<RuntimeRecordEnvelopeResult> {
    const normalized = normalizeRecord(input);
    assertRecordScope(normalized);
    return this.executor.transaction(async (transactionExecutor) => {
      await assertTenantSession(transactionExecutor, this.tenantId, normalized.outbox.sessionId);
      if (normalized.outbox.runId) {
        const run = await lockTenantRun(transactionExecutor, this.tenantId, normalized.outbox.runId);
        if (!run || run.session_id !== normalized.outbox.sessionId) {
          throw new Error(`run does not belong to session: ${normalized.outbox.runId}`);
        }
      }
      await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${normalized.outbox.eventId}`);
      return recordEnvelope(
        createTransactionFacade(this.tenantId, transactionExecutor),
        transactionExecutor,
        this.tenantId,
        normalized,
      );
    });
  }

  private async persistMessage(input: RuntimePersistMessageInput): Promise<RuntimePersistMessageResult> {
    assertContinuationScope(input);
    return this.executor.transaction(async (transactionExecutor) => {
      await assertTenantSession(transactionExecutor, this.tenantId, input.message.sessionId);
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const deletedProviderContinuations = input.deleteProviderContinuationThreadKey
        ? await tx.providerContinuations.deleteProviderContinuations(
          input.message.sessionId,
          input.deleteProviderContinuationThreadKey,
        )
        : 0;
      const message = await getOrCreateMessage(transactionExecutor, tx, input.message, "message");
      const providerContinuation = input.providerContinuation
        ? await tx.providerContinuations.putProviderContinuation(input.providerContinuation)
        : null;
      return { message, deletedProviderContinuations, providerContinuation };
    });
  }

  private async recordInteraction(input: RuntimeRecordInteractionInput): Promise<RuntimeRecordInteractionResult> {
    const rootCallId = input.rootCallId.trim();
    if (!rootCallId) throw new Error("interaction requires a rootCallId");
    assertRecordScope(input.record, input.interaction.sessionId, input.interaction.runId);
    assertInteractionEnvelope(input.record, input.interaction, "required");
    const normalized = normalizeRecord(input.record);
    const expected = {
      ...input.interaction,
      requestPayload: { ...input.interaction.requestPayload, rootCallId },
    };
    return this.executor.transaction(async (transactionExecutor) => {
      await assertTenantSession(transactionExecutor, this.tenantId, expected.sessionId);
      await lockAdvisoryKey(transactionExecutor, `interaction:${this.tenantId}:${expected.interactionId}`);
      await lockAdvisoryKey(
        transactionExecutor,
        `interaction-root:${this.tenantId}:${expected.sessionId}:${expected.rootRunId}`,
      );
      await lockAdvisoryKey(
        transactionExecutor,
        `interaction-batch:${this.tenantId}:${expected.sessionId}:${expected.batchId}`,
      );
      await assertRunBelongsToRoot(
        transactionExecutor,
        this.tenantId,
        expected.sessionId,
        expected.runId,
        expected.rootRunId,
      );
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      assertInteractionBatchRoot(
        await tx.pendingInteractions.listPendingInteractions({
          sessionId: expected.sessionId,
          batchId: expected.batchId,
        }),
        expected.rootRunId,
      );
      const existing = await tx.pendingInteractions.getPendingInteraction(expected.sessionId, expected.interactionId);
      const interaction = existing ?? await tx.pendingInteractions.createPendingInteraction(expected);
      assertInteractionIdentity(interaction, expected);
      await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${normalized.outbox.eventId}`);
      return {
        interaction,
        record: await recordEnvelope(tx, transactionExecutor, this.tenantId, normalized),
      };
    });
  }

  private async resolveInteraction(input: RuntimeResolveInteractionInput): Promise<RuntimeResolveInteractionResult> {
    return this.executor.transaction(async (transactionExecutor) => {
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      await lockAdvisoryKey(transactionExecutor, `interaction:${this.tenantId}:${input.interactionId}`);
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const current = await tx.pendingInteractions.getPendingInteraction(input.sessionId, input.interactionId);
      if (!current) throw new Error(`pending interaction not found: ${input.interactionId}`);
      await lockAdvisoryKey(
        transactionExecutor,
        `interaction-root:${this.tenantId}:${input.sessionId}:${current.root_run_id}`,
      );
      await lockAdvisoryKey(
        transactionExecutor,
        `interaction-batch:${this.tenantId}:${input.sessionId}:${current.batch_id}`,
      );
      const rootRun = await lockTenantRun(transactionExecutor, this.tenantId, current.root_run_id);
      if (!rootRun || rootRun.session_id !== input.sessionId) {
        throw new Error(`interaction root run not found: ${current.root_run_id}`);
      }
      if (current.kind !== input.resolution.kind) {
        throw new Error(`pending interaction kind conflict: ${input.interactionId}`);
      }
      if (current.status === "cancelled") {
        throw new Error(`pending interaction is cancelled: ${input.interactionId}`);
      }
      assertRecordScope(input.record, input.sessionId, current.run_id);
      assertInteractionEnvelope(input.record, toCreatePendingInput(current), "responded");
      const normalized = normalizeRecord(input.record);
      const resolution = resolutionPayload(input.resolution);
      if (current.resolution_payload && !isDeepStrictEqual(current.resolution_payload, resolution)) {
        throw new Error(`pending interaction resolution conflict: ${input.interactionId}`);
      }
      const previousStatus = current.status;
      let changed = false;
      if (current.status === "waiting" || current.status === "suspended") {
        changed = await tx.pendingInteractions.updatePendingInteractionStatus({
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
      const interaction = await tx.pendingInteractions.getPendingInteraction(input.sessionId, input.interactionId);
      if (!interaction) throw new Error(`pending interaction disappeared: ${input.interactionId}`);
      const batch = await tx.pendingInteractions.listPendingInteractions({
        sessionId: input.sessionId,
        batchId: current.batch_id,
      });
      assertInteractionBatchRoot(batch, current.root_run_id);
      const batchReady = (await tx.pendingInteractions.listPendingInteractions({
        sessionId: input.sessionId,
        batchId: current.batch_id,
        statuses: ["waiting", "suspended"],
      })).length === 0;
      await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${normalized.outbox.eventId}`);
      return {
        interaction,
        previousStatus,
        changed,
        batchReady,
        rootRunStatus: rootRun.status,
        record: await recordEnvelope(tx, transactionExecutor, this.tenantId, normalized),
      };
    });
  }

  private async claimResume(input: RuntimeClaimResumeInput): Promise<RuntimeClaimResumeResult> {
    const claimId = input.claimId.trim();
    if (!claimId) throw new Error("resume claimId must not be empty");
    return this.executor.transaction(async (transactionExecutor): Promise<RuntimeClaimResumeResult> => {
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const session = await tx.conversation.getSession(input.sessionId);
      if (!session) return { claimed: false, reason: "not_found" };
      await lockAdvisoryKey(transactionExecutor, `interaction:${this.tenantId}:${input.interactionId}`);
      const interaction = await tx.pendingInteractions.getPendingInteraction(input.sessionId, input.interactionId);
      if (!interaction) return { claimed: false, reason: "not_found" };
      await lockAdvisoryKey(
        transactionExecutor,
        `interaction-root:${this.tenantId}:${input.sessionId}:${interaction.root_run_id}`,
      );
      await lockAdvisoryKey(
        transactionExecutor,
        `interaction-batch:${this.tenantId}:${input.sessionId}:${interaction.batch_id}`,
      );
      const batch = await tx.pendingInteractions.listPendingInteractions({
        sessionId: input.sessionId,
        batchId: interaction.batch_id,
      });
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
      const rootRun = await lockTenantRun(transactionExecutor, this.tenantId, interaction.root_run_id);
      if (!rootRun || rootRun.session_id !== input.sessionId) return { claimed: false, reason: "not_found" };
      if (rootRun.status !== "suspended") {
        return { claimed: false, reason: rootRun.status !== "running" ? "terminal" : "root_not_suspended" };
      }
      const repository = new PostgresPendingInteractionRepository(transactionExecutor);
      const claimed = await repository.claimPendingBatch(input.sessionId, interaction.batch_id, claimId);
      if (claimed !== batch.length) {
        throw new Error(`resume batch claim was partial: ${interaction.batch_id}`);
      }
      if (!await tx.runs.updateRunStatus(rootRun.run_id, input.sessionId, "running", null)) {
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
  }

  private async rollbackResume(input: RuntimeRollbackResumeInput): Promise<RuntimeRollbackResumeResult> {
    return this.executor.transaction(async (transactionExecutor) => {
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      await lockAdvisoryKey(
        transactionExecutor,
        `interaction-root:${this.tenantId}:${input.sessionId}:${input.rootRunId}`,
      );
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const claimed = (await tx.pendingInteractions.listPendingInteractions({
        sessionId: input.sessionId,
        rootRunId: input.rootRunId,
      })).filter((item) => item.status === "resuming" && item.resume_claim_id === input.claimId);
      if (claimed.length === 0) return { rolledBack: false };
      for (const batchId of [...new Set(claimed.map((item) => item.batch_id))].sort()) {
        await lockAdvisoryKey(
          transactionExecutor,
          `interaction-batch:${this.tenantId}:${input.sessionId}:${batchId}`,
        );
      }
      assertInteractionBatchRoot(claimed, input.rootRunId);
      const rootRun = await lockTenantRun(transactionExecutor, this.tenantId, input.rootRunId);
      if (!rootRun || rootRun.session_id !== input.sessionId || rootRun.status !== "running") {
        return { rolledBack: false };
      }
      const repository = new PostgresPendingInteractionRepository(transactionExecutor);
      const released = await repository.releasePendingClaim(input.sessionId, input.rootRunId, input.claimId);
      if (released !== claimed.length) throw new Error(`resume claim rollback was partial: ${input.claimId}`);
      if (!await tx.runs.updateRunStatus(input.rootRunId, input.sessionId, "suspended", null)) {
        throw new Error(`resume root run rollback failed: ${input.rootRunId}`);
      }
      return { rolledBack: true };
    });
  }

  private async finalizeRun(input: RuntimeFinalizeRunInput): Promise<RuntimeFinalizeRunResult> {
    assertTerminalMessageRule(input);
    if (input.finalMessage) {
      assertSessionId(input.finalMessage.sessionId, input.sessionId, "final message");
    }
    return this.executor.transaction(async (transactionExecutor) => {
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      const run = await lockTenantRun(transactionExecutor, this.tenantId, input.runId);
      if (!run || run.session_id !== input.sessionId) {
        throw new Error(`run not found while finalizing: ${input.runId}`);
      }
      assertTerminalTransition(run.status, input.status, input.runId);
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      if (input.deleteProviderContinuationThreadKey) {
        await tx.providerContinuations.deleteProviderContinuations(
          input.sessionId,
          input.deleteProviderContinuationThreadKey,
        );
      }
      if (input.suspendRootRunId) {
        await tx.pendingInteractions.suspendPendingInteractions(
          input.sessionId,
          input.suspendRootRunId,
        );
      }
      if (input.closeDanglingToolCalls) {
        const messages = await tx.conversation.getRecentMessages(
          input.sessionId,
          1000,
          input.closeDanglingToolCalls.threadKey,
        );
        for (const message of buildInterruptedToolMessages(messages, {
          sessionId: input.sessionId,
          runId: input.runId,
          ...input.closeDanglingToolCalls,
        })) {
          await getOrCreateMessage(transactionExecutor, tx, message, "interrupted tool message");
        }
      }
      const finalMessage = input.finalMessage
        ? await getOrCreateMessage(transactionExecutor, tx, input.finalMessage, "final message")
        : null;
      if (run.status === input.status && run.final_message_id !== (finalMessage?.id ?? null)) {
        throw new Error(`run final message conflicts with idempotent finalize: ${input.runId}`);
      }
      const terminalRecords = input.buildTerminalRecords?.(finalMessage) ?? [];
      const records: RuntimeRecordEnvelopeResult[] = [];
      for (const terminalRecord of terminalRecords) {
        const normalized = normalizeRecord(terminalRecord);
        assertRecordScope(normalized, input.sessionId, input.runId);
        await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${normalized.outbox.eventId}`);
        records.push(await recordEnvelope(tx, transactionExecutor, this.tenantId, normalized));
      }
      if (finalMessage && input.attachStepsToFinalMessage !== false) {
        await tx.runs.updateRunStepsMessageId(input.sessionId, input.runId, finalMessage.id);
      }
      if (run.status === "running") {
        const updated = await tx.runs.updateRunStatus(
          input.runId,
          input.sessionId,
          input.status,
          finalMessage?.id ?? null,
        );
        if (!updated) {
          throw new Error(`run not found while finalizing: ${input.runId}`);
        }
      }
      return { finalMessage, records };
    });
  }
}

async function recordEnvelope(
  tx: RuntimeStorageRepositories,
  executor: PostgresMemoryExecutor,
  tenantId: TenantId,
  input: RuntimeRecordEnvelopeInput,
): Promise<RuntimeRecordEnvelopeResult> {
  const eventId = input.outbox.eventId.trim();
  const existingStep = await findEventStep(executor, tenantId, eventId);
  const existingOutbox = await findEventOutbox(executor, tenantId, eventId);
  if (existingStep || existingOutbox) {
    assertExistingRecord(input, existingStep, existingOutbox);
    return { step: existingStep?.record ?? null, outbox: existingOutbox! };
  }
  const step = input.step
    ? await tx.runs.addRunStep({ ...input.step, eventId } as Parameters<RuntimeRunStorage["addRunStep"]>[0])
    : null;
  const outbox = await tx.outbox.appendOutbox(input.outbox);
  return { step, outbox };
}

function assertRecordScope(
  input: RuntimeRecordEnvelopeInput,
  expectedSessionId?: string,
  expectedRunId?: string,
): void {
  if (expectedSessionId) assertSessionId(input.outbox.sessionId, expectedSessionId, "terminal outbox");
  if (expectedRunId && input.outbox.runId !== expectedRunId) {
    throw new Error(`terminal outbox run mismatch: expected ${expectedRunId}, received ${String(input.outbox.runId)}`);
  }
  if (!input.step) return;
  assertSessionId(input.step.sessionId, expectedSessionId ?? input.outbox.sessionId, "run step");
  if (input.outbox.runId !== input.step.runId) {
    throw new Error(`execution record run mismatch: step ${input.step.runId}, outbox ${String(input.outbox.runId)}`);
  }
}

function assertSessionId(actual: string, expected: string, subject: string): void {
  if (actual !== expected) {
    throw new Error(`${subject} session mismatch: expected ${expected}, received ${actual}`);
  }
}

interface ExistingEventStep {
  record: RunStepRecord;
  sessionId: string;
  payload: Record<string, unknown>;
}

async function lockAdvisoryKey(executor: PostgresMemoryExecutor, key: string): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

async function assertTenantSession(
  executor: PostgresMemoryExecutor,
  tenantId: TenantId,
  sessionId: string,
  allowMissing = false,
): Promise<boolean> {
  const result = await executor.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM conversation_sessions WHERE session_id=$1 FOR UPDATE",
    [sessionId],
  );
  const owner = result.rows[0]?.tenant_id;
  if (!owner) {
    if (allowMissing) return false;
    throw new Error(`session not found: ${sessionId}`);
  }
  if (owner !== tenantId) {
    throw new Error(`session belongs to another tenant: ${sessionId}`);
  }
  return true;
}

async function assertRunBelongsToRoot(
  executor: PostgresMemoryExecutor,
  tenantId: TenantId,
  sessionId: string,
  runId: string,
  rootRunId: string,
): Promise<void> {
  let run = await lockTenantRun(executor, tenantId, runId);
  if (!run || run.session_id !== sessionId) throw new Error(`interaction run not found: ${runId}`);
  const visited = new Set<string>();
  while (run.run_id !== rootRunId) {
    if (!run.parent_run_id || visited.has(run.run_id)) {
      throw new Error(`interaction run is outside root tree: ${runId} -> ${rootRunId}`);
    }
    visited.add(run.run_id);
    run = await lockTenantRun(executor, tenantId, run.parent_run_id);
    if (!run || run.session_id !== sessionId) throw new Error(`interaction parent run not found: ${runId}`);
  }
  if (run.parent_run_id !== null) throw new Error(`interaction root run is not a root: ${rootRunId}`);
}

async function lockTenantRun(
  executor: PostgresMemoryExecutor,
  tenantId: TenantId,
  runId: string,
): Promise<RunInfo | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary,
      request_id, user_id, agent_name, thread_key, parent_run_id, parent_call_id,
      child_agent_id, final_message_id, created_at, updated_at
     FROM saas_runs WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [tenantId, runId],
  );
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

function assertRunScope(existing: RunInfo, expected: RuntimeStartRunInput["run"]): void {
  const conflicts = [
    ["session", existing.session_id, expected.sessionId],
    ["thread", existing.thread_key, expected.threadKey?.trim() || "root"],
    ["parent run", existing.parent_run_id, expected.parentRunId ?? null],
    ["parent call", existing.parent_call_id, expected.parentCallId ?? null],
    ["child agent", existing.child_agent_id, expected.childAgentId ?? null],
    ["agent", existing.agent_name, expected.agentName ?? null],
  ] as const;
  const conflict = conflicts.find(([, actual, value]) => actual !== value);
  if (conflict) {
    throw new Error(`run scope conflict (${conflict[0]}): ${existing.run_id}`);
  }
}

function toCreatedRun(run: RunInfo): RuntimeStartRunResult["run"] {
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

function assertTerminalTransition(current: string, target: string, runId: string): void {
  if (current === "running" || current === target) return;
  throw new Error(`run terminal status conflict: ${runId} is ${current}, cannot become ${target}`);
}

async function getOrCreateMessage(
  executor: PostgresMemoryExecutor,
  tx: RuntimeStorageRepositories,
  input: AddMessageInput & { messageId: string },
  subject: string,
): Promise<MessageInfo> {
  await lockAdvisoryKey(executor, `message:${input.messageId}`);
  const owner = await executor.query<{ session_id: string }>(
    "SELECT session_id FROM conversation_messages WHERE id=$1 FOR UPDATE",
    [input.messageId],
  );
  if (owner.rows[0] && owner.rows[0].session_id !== input.sessionId) {
    throw new Error(`${subject} belongs to another session: ${input.messageId}`);
  }
  const existing = owner.rows[0]
    ? await tx.conversation.getMessageById(input.sessionId, input.messageId)
    : null;
  if (!existing) return tx.conversation.addMessage(input);
  assertMessageIdentity(existing, input, subject);
  return existing;
}

function assertMessageIdentity(existing: MessageInfo, expected: AddMessageInput, subject: string): void {
  const expectedThread = expected.threadKey?.trim() || "root";
  const equal = existing.session_id === expected.sessionId
    && existing.role === expected.role
    && existing.content === expected.content
    && existing.thread_key === expectedThread
    && existing.child_agent_id === (expected.childAgentId ?? null)
    && (existing.tool_call_id ?? null) === (expected.toolCallId ?? null)
    && (existing.name ?? null) === (expected.name ?? null)
    && jsonEqual(existing.tool_calls ?? null, expected.toolCalls ?? null)
    && Object.entries(expected.metadata ?? {}).every(
      ([key, value]) => jsonEqual(existing.metadata[key], value),
    );
  if (!equal) throw new Error(`${subject} immutable fields conflict: ${existing.id}`);
}

async function findEventStep(
  executor: PostgresMemoryExecutor,
  tenantId: TenantId,
  eventId: string,
): Promise<ExistingEventStep | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT id, session_id, run_id, event_id, step_order, step_type, payload
     FROM saas_run_steps WHERE tenant_id=$1 AND event_id=$2 FOR UPDATE`,
    [tenantId, eventId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    record: {
      id: Number(row.id),
      run_id: String(row.run_id),
      event_id: String(row.event_id),
      step_order: Number(row.step_order),
      step_type: String(row.step_type),
    },
    sessionId: String(row.session_id),
    payload: jsonObject(row.payload),
  };
}

async function findEventOutbox(
  executor: PostgresMemoryExecutor,
  tenantId: TenantId,
  eventId: string,
): Promise<OutboxRow | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT id,event_id,session_id,tenant_id,run_id,session_seq,event_type,
      aggregate_type,aggregate_id,payload,status,attempts,available_at,locked_at,
      delivered_at,last_error,created_at
     FROM event_outbox WHERE tenant_id=$1 AND event_id=$2 FOR UPDATE`,
    [tenantId, eventId],
  );
  const row = result.rows[0];
  return row ? mapOutbox(row) : null;
}

function assertExistingRecord(
  expected: RuntimeRecordEnvelopeInput,
  step: ExistingEventStep | null,
  outbox: OutboxRow | null,
): void {
  if (!outbox || Boolean(step) !== Boolean(expected.step)) {
    throw new Error(`incomplete execution event record: ${expected.outbox.eventId}`);
  }
  const outboxMatches = outbox.session_id === expected.outbox.sessionId
    && outbox.run_id === (expected.outbox.runId ?? null)
    && outbox.event_type === expected.outbox.eventType
    && outbox.aggregate_type === expected.outbox.aggregateType
    && outbox.aggregate_id === expected.outbox.aggregateId
    && jsonEqual(jsonObject(outbox.payload), expected.outbox.payload);
  const stepMatches = !step || !expected.step || (
    step.sessionId === expected.step.sessionId
    && step.record.run_id === expected.step.runId
    && step.record.step_type === expected.step.stepType
    && jsonEqual(step.payload, expected.step.payload)
  );
  if (!outboxMatches || !stepMatches) {
    throw new Error(`execution event idempotency conflict: ${expected.outbox.eventId}`);
  }
}

function assertEventId(eventId: string): void {
  if (!eventId.trim()) throw new Error("execution outbox requires a non-empty eventId");
}

function assertTerminalMessageRule(input: RuntimeFinalizeRunInput): void {
  if (input.status === "completed" && !input.finalMessage) {
    throw new Error("completed finalize requires a final message");
  }
  if ((input.status === "failed" || input.status === "suspended") && input.finalMessage) {
    throw new Error(`${input.status} finalize must not include a final message`);
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

function assertInteractionIdentity(
  existing: PendingInteractionRecord,
  input: CreatePendingInteractionInput,
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
  interaction: CreatePendingInteractionInput,
  phase: "required" | "responded",
): void {
  const expectedEventId = `${interaction.interactionId}:${phase}`;
  const outer = jsonObject(record.outbox.payload);
  const event = jsonObject(outer.client_event);
  const payload = jsonObject(event.payload);
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

function toCreatePendingInput(record: PendingInteractionRecord): CreatePendingInteractionInput {
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

function interactionResolution(record: PendingInteractionRecord): RuntimeInteractionResolution {
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
  batch: readonly PendingInteractionRecord[],
  rootRunId: string,
): void {
  if (batch.some((item) => item.root_run_id !== rootRunId)) {
    throw new Error(`pending interaction batch spans multiple root runs: ${batch[0]?.batch_id ?? "unknown"}`);
  }
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeRecord(input: RuntimeRecordEnvelopeInput): RuntimeRecordEnvelopeInput {
  assertEventId(input.outbox.eventId);
  return {
    ...input,
    outbox: { ...input.outbox, eventId: input.outbox.eventId.trim() },
  };
}

function mapRun(row: Record<string, unknown>): RunInfo {
  const nullable = (value: unknown): string | null => value == null ? null : String(value);
  return {
    run_id: String(row.run_id), session_id: String(row.session_id), tenant_id: String(row.tenant_id),
    entrypoint: nullable(row.entrypoint), status: String(row.status), task_summary: nullable(row.task_summary),
    request_id: nullable(row.request_id), user_id: nullable(row.user_id), agent_name: nullable(row.agent_name),
    thread_key: String(row.thread_key ?? "root"), parent_run_id: nullable(row.parent_run_id),
    parent_call_id: nullable(row.parent_call_id), child_agent_id: nullable(row.child_agent_id),
    final_message_id: nullable(row.final_message_id), created_at: iso(row.created_at), updated_at: iso(row.updated_at),
  };
}

function mapOutbox(row: Record<string, unknown>): OutboxRow {
  return {
    id: Number(row.id), event_id: String(row.event_id), session_id: String(row.session_id),
    tenant_id: String(row.tenant_id), run_id: row.run_id == null ? null : String(row.run_id),
    session_seq: Number(row.session_seq), event_type: String(row.event_type),
    aggregate_type: String(row.aggregate_type), aggregate_id: String(row.aggregate_id),
    payload: typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload ?? {}),
    status: row.status as OutboxRow["status"], attempts: Number(row.attempts),
    available_at: row.available_at == null ? null : iso(row.available_at),
    locked_at: row.locked_at == null ? null : iso(row.locked_at),
    delivered_at: row.delivered_at == null ? null : iso(row.delivered_at),
    last_error: row.last_error == null ? null : String(row.last_error), created_at: iso(row.created_at),
  };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function iso(value: unknown): string {
  return new Date(String(value)).toISOString();
}
