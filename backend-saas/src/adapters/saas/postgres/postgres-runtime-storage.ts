import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";

import { RuntimeInteractionUnavailableError } from "@ragsystem/backend-core/contracts/storage/runtime-storage.js";
import type {
  RuntimeAtomicOperations,
  RuntimeAttachResumeInput,
  RuntimeAttachResumeResult,
  RuntimeClaimResumeInput,
  RuntimeClaimResumeResult,
  RuntimeClaimSessionMaintenanceResult,
  RuntimeConsumePendingFollowupsInput,
  RuntimeConsumePendingFollowupsResult,
  RuntimeConversationStorage,
  RuntimeFinalizeRunInput,
  RuntimeFinalizeRunResult,
  RuntimeInteractionResolution,
  RuntimeInterruptSessionInput,
  RuntimeInterruptSessionResult,
  RuntimePersistMessageInput,
  RuntimePersistMessageResult,
  RuntimeOutboxStorage,
  RuntimePendingInteractionStorage,
  RuntimeProviderContinuationStorage,
  RuntimeRecordEnvelopeInput,
  RuntimeRecordEnvelopeResult,
  RuntimeRecordInteractionInput,
  RuntimeRecordInteractionResult,
  RuntimeRecoverExpiredResumeClaimsInput,
  RuntimeRecoverExpiredResumeClaimsResult,
  RuntimeRecoverExpiredRunLeasesInput,
  RuntimeRecoverExpiredRunLeasesResult,
  RuntimeRenewRunLeaseInput,
  RuntimeRenewRunLeaseResult,
  RuntimeResolveInteractionInput,
  RuntimeResolveInteractionResult,
  RuntimeRollbackResumeInput,
  RuntimeRollbackResumeResult,
  RuntimeRunStorage,
  RuntimeStartRunInput,
  RuntimeStartRunResult,
  RuntimeStartOrAppendRootInput,
  RuntimeStartOrAppendRootResult,
  RuntimeStorage,
  RuntimeSessionMaintenanceInput,
  RuntimeSessionFacts,
  RuntimeStorageRepositories,
} from "@ragsystem/backend-core/contracts/storage/runtime-storage.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type {
  AddMessageInput,
  CreatePendingInteractionInput,
  OutboxRow,
  PendingInteractionRecord,
  RunInfo,
  RunStepRecord,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import { toSessionIdentity, type MessageInfo } from "@ragsystem/backend-core/contracts/session/session.js";
import {
  buildRunTerminalRecords,
  buildTerminalAssistantMessage,
  buildTerminalToolMessages,
} from "@ragsystem/backend-core/contracts/storage/runtime-finalization.js";
import type { PostgresExecutor } from "./postgres-executor.js";
import { PostgresConversationRepository } from "./conversation-repository.js";
import { PostgresOutboxRepository } from "./outbox-repository.js";
import { PostgresPendingInteractionRepository } from "./pending-interaction-repository.js";
import { PostgresProviderContinuationRepository } from "./provider-continuation-repository.js";
import { PostgresRunRepository } from "./run-repository.js";

function createTransactionFacade(
  tenantId: TenantId,
  executor: PostgresExecutor,
): RuntimeStorageRepositories {
  const conversationRepository = new PostgresConversationRepository(executor);
  const runRepository = new PostgresRunRepository(executor);
  const outboxRepository = new PostgresOutboxRepository(executor);
  const pendingInteractionRepository = new PostgresPendingInteractionRepository(executor);
  const providerContinuationRepository = new PostgresProviderContinuationRepository(executor);

  const conversation: RuntimeConversationStorage = {
    createSession: (input) => conversationRepository.createSession({ tenantId, ...input }),
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
    updateRunStatus: (runId, sessionId, status, finalMessageId, terminalReason) => runRepository.updateRunStatus(
      tenantId,
      runId,
      sessionId,
      status,
      finalMessageId,
      terminalReason,
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
    finalizePendingInteractions: pendingInteractionRepository.finalizePendingInteractions.bind(pendingInteractionRepository),
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
    private readonly executor: PostgresExecutor,
    private readonly ownerInstanceId = `runtime-${randomUUID()}`,
    private readonly rootLeaseMs = 60_000,
  ) {
    validateRunLeaseMs(rootLeaseMs);
    this.operations = {
      startRun: (input) => this.startRun(input),
      startOrAppendRoot: (input) => this.startOrAppendRoot(input),
      persistMessage: (input) => this.persistMessage(input),
      recordEnvelope: (input) => this.recordEnvelope(input),
      recordInteraction: (input) => this.recordInteraction(input),
      resolveInteraction: (input) => this.resolveInteraction(input),
      claimResume: (input) => this.claimResume(input),
      attachResume: (input) => this.attachResume(input),
      rollbackResume: (input) => this.rollbackResume(input),
      interruptSession: (input) => this.interruptSession(input),
      recoverExpiredResumeClaims: (input) => this.recoverExpiredResumeClaims(input),
      renewRunLease: (input) => this.renewRunLease(input),
      recoverExpiredRunLeases: (input) => this.recoverExpiredRunLeases(input),
      getActiveRootRun: (sessionId) => this.getActiveRootRun(sessionId),
      getSessionRuntimeFacts: (sessionId) => this.getSessionRuntimeFacts(sessionId),
      consumePendingFollowups: (input) => this.consumePendingFollowups(input),
      claimSessionMaintenance: (input) => this.claimSessionMaintenance(input),
      renewSessionMaintenance: (input) => this.renewSessionMaintenance(input),
      releaseSessionMaintenance: (input) => this.releaseSessionMaintenance(input),
      finalizeRun: (input) => this.finalizeRun(input),
    };
  }

  private async getSessionRuntimeFacts(sessionId: string): Promise<RuntimeSessionFacts> {
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${sessionId}`);
      const exists = await assertTenantSession(transactionExecutor, this.tenantId, sessionId, true);
      if (!exists) {
        return {
          session: null,
          activeRootRun: null,
          latestTerminalRootRun: null,
          pendingInteractions: [],
          activeRunEvents: [],
          ownedByCurrentInstance: false,
        };
      }
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const session = await tx.conversation.getSession(sessionId);
      const activeRoots = await transactionExecutor.query<Record<string, unknown>>(
        `SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                child_agent_id, final_message_id, created_at, updated_at,
                owner_instance_id, lease_expires_at,
                (owner_instance_id=$3 AND lease_expires_at > CURRENT_TIMESTAMP) AS owned_by_current_instance
         FROM saas_runs
         WHERE tenant_id=$1 AND session_id=$2
           AND (
             (parent_run_id IS NULL AND child_agent_id IS NULL)
             OR EXISTS (
               SELECT 1 FROM pending_interactions AS pending
               WHERE pending.session_id=$2
                 AND pending.root_run_id=saas_runs.run_id
                 AND pending.status IN ('waiting','suspended','resolved','resuming')
             )
           )
           AND status IN ('running','suspended')
         ORDER BY (parent_run_id IS NULL AND child_agent_id IS NULL) DESC,
                  updated_at DESC, created_at DESC, run_id DESC
         LIMIT 1`,
        [this.tenantId, sessionId, this.ownerInstanceId],
      );
      const terminalRoots = await transactionExecutor.query<Record<string, unknown>>(
        `SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                child_agent_id, final_message_id, created_at, updated_at
         FROM saas_runs
         WHERE tenant_id=$1 AND session_id=$2 AND parent_run_id IS NULL AND child_agent_id IS NULL
           AND status IN ('completed','failed','interrupted')
         ORDER BY updated_at DESC, created_at DESC, run_id DESC
         LIMIT 1`,
        [this.tenantId, sessionId],
      );
      const activeRow = activeRoots.rows[0] ?? null;
      const activeRootRun = activeRow ? mapRun(activeRow) : null;
      const pendingInteractions = await tx.pendingInteractions.listPendingInteractions({
        sessionId,
        statuses: ["waiting", "suspended", "resolved", "resuming"],
      });
      const activeRunIds = activeRootRun
        ? (await transactionExecutor.query<{ run_id: string }>(
            `WITH RECURSIVE run_tree AS (
               SELECT run_id FROM saas_runs WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3
               UNION ALL
               SELECT child.run_id
               FROM saas_runs AS child
               JOIN run_tree AS parent ON child.parent_run_id=parent.run_id
               WHERE child.tenant_id=$1 AND child.session_id=$2
             )
             SELECT run_id FROM run_tree`,
            [this.tenantId, sessionId, activeRootRun.run_id],
          )).rows.map((row) => row.run_id)
        : [];
      return {
        session,
        activeRootRun,
        latestTerminalRootRun: terminalRoots.rows[0] ? mapRun(terminalRoots.rows[0]) : null,
        pendingInteractions,
        activeRunEvents: activeRunIds.length > 0
          ? (await Promise.all([
              tx.outbox.listOutboxForReplay({
                sessionId,
                runIds: activeRunIds,
                limit: 500,
                latest: true,
                eventTypes: [
                  "client.agent_ended",
                  "client.model_request",
                  "client.model_attempt_started",
                  "client.model_attempt_failed",
                  "client.model_attempt_completed",
                  "client.tool_call",
                  "client.tool_result",
                ],
              }),
              tx.outbox.listOutboxForReplay({
                sessionId,
                runIds: activeRunIds,
                limit: 100,
                latest: true,
                eventTypes: ["client.stream_output"],
              }),
            ])).flat().sort((left, right) => left.session_seq - right.session_seq)
          : [],
        ownedByCurrentInstance: activeRootRun?.status === "running"
          && activeRow?.owned_by_current_instance === true,
      };
    });
  }

  private async getActiveRootRun(sessionId: string): Promise<{ runId: string | null }> {
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${sessionId}`);
      const exists = await assertTenantSession(transactionExecutor, this.tenantId, sessionId, true);
      if (!exists) return { runId: null };
      const active = await transactionExecutor.query<{ run_id: string }>(
        `SELECT run_id FROM saas_runs
         WHERE tenant_id=$1 AND session_id=$2 AND parent_run_id IS NULL
           AND status IN ('running','suspended')
         ORDER BY created_at DESC LIMIT 1`,
        [this.tenantId, sessionId],
      );
      return { runId: active.rows[0]?.run_id ?? null };
    });
  }

  private async consumePendingFollowups(
    input: RuntimeConsumePendingFollowupsInput,
  ): Promise<RuntimeConsumePendingFollowupsResult> {
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      await assertOwnedRunLeaseForRun(
        transactionExecutor,
        this.tenantId,
        this.ownerInstanceId,
        input.sessionId,
        input.rootRunId,
      );
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const messages: MessageInfo[] = [];
      for (const messageId of input.messageIds) {
        await lockAdvisoryKey(transactionExecutor, `message:${messageId}`);
        const pending = await tx.conversation.getMessageById(input.sessionId, messageId);
        if (!pending || pending.role !== "user" || jsonObject(pending.metadata).followup_pending !== true) continue;
        const metadata = {
          ...pending.metadata,
          followup_pending: false,
          run_id: input.rootRunId,
          consumed_by_run_id: input.rootRunId,
          followup_continuation_trigger: false,
        };
        const updated = await transactionExecutor.query(
          `UPDATE conversation_messages
           SET metadata=$1::jsonb
           WHERE session_id=$2 AND id=$3 AND role='user'
             AND metadata->>'followup_pending'='true'`,
          [JSON.stringify(metadata), input.sessionId, messageId],
        );
        if (Number(updated.rowCount ?? 0) !== 1) continue;
        messages.push({ ...pending, metadata });
      }
      return { messages };
    });
  }

  private async claimSessionMaintenance(
    input: RuntimeSessionMaintenanceInput,
  ): Promise<RuntimeClaimSessionMaintenanceResult> {
    const ttlMs = validateMaintenanceTtlMs(input.ttlMs);
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
      const exists = await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId, true);
      if (!exists) return { claimed: false, activeRunId: null };
      const active = await transactionExecutor.query<{ run_id: string }>(
        `SELECT run_id FROM saas_runs
         WHERE tenant_id=$1 AND session_id=$2 AND status IN ('running','suspended')
         ORDER BY created_at DESC LIMIT 1`,
        [this.tenantId, input.sessionId],
      );
      if (active.rows[0]) return { claimed: false, activeRunId: active.rows[0].run_id };
      const claimed = await transactionExecutor.query(
        `UPDATE conversation_sessions
         SET metadata=jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{runtime_maintenance}',
               jsonb_build_object(
                 'token', $1::text,
                 'kind', $2::text,
                 'expires_at', (CURRENT_TIMESTAMP + ($3::bigint * INTERVAL '1 millisecond'))::text
               ),
               true
             ),
             updated_at=CURRENT_TIMESTAMP
         WHERE tenant_id=$4 AND session_id=$5
           AND (
             metadata->'runtime_maintenance' IS NULL
             OR metadata->'runtime_maintenance'='null'::jsonb
             OR metadata#>>'{runtime_maintenance,token}'=$6
             OR NULLIF(metadata#>>'{runtime_maintenance,expires_at}', '')::timestamptz <= CURRENT_TIMESTAMP
           )`,
        [input.token, input.kind, ttlMs, this.tenantId, input.sessionId, input.token],
      );
      return { claimed: Number(claimed.rowCount ?? 0) === 1, activeRunId: null };
    });
  }

  private async releaseSessionMaintenance(input: { sessionId: string; token: string }): Promise<void> {
    await this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
      await transactionExecutor.query(
        `UPDATE conversation_sessions
         SET metadata=COALESCE(metadata, '{}'::jsonb) - 'runtime_maintenance', updated_at=CURRENT_TIMESTAMP
         WHERE tenant_id=$1 AND session_id=$2
           AND metadata#>>'{runtime_maintenance,token}'=$3`,
        [this.tenantId, input.sessionId, input.token],
      );
    });
  }

  private async renewSessionMaintenance(input: { sessionId: string; token: string; ttlMs?: number }): Promise<boolean> {
    const ttlMs = validateMaintenanceTtlMs(input.ttlMs);
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
      const renewed = await transactionExecutor.query(
        `UPDATE conversation_sessions
         SET metadata=jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{runtime_maintenance,expires_at}',
               to_jsonb((CURRENT_TIMESTAMP + ($1::bigint * INTERVAL '1 millisecond'))::text),
               true
             ),
             updated_at=CURRENT_TIMESTAMP
         WHERE tenant_id=$2 AND session_id=$3
           AND metadata#>>'{runtime_maintenance,token}'=$4`,
        [ttlMs, this.tenantId, input.sessionId, input.token],
      );
      return Number(renewed.rowCount ?? 0) === 1;
    });
  }

  private async startRun(input: RuntimeStartRunInput): Promise<RuntimeStartRunResult> {
    assertSessionId(input.run.sessionId, input.session.sessionId, "run");
    if (input.initialUserMessage) {
      assertSessionId(input.initialUserMessage.sessionId, input.session.sessionId, "initial user message");
    }
    const initialRecords = (input.initialRecords ?? []).map(normalizeRecord);
    for (const record of initialRecords) {
      assertRecordScope(record, input.session.sessionId, input.run.runId);
    }
    return this.executor.transaction(async (transactionExecutor) => {
      // Session lifecycle operations (start/stop/resolve/resume/finalize) share
      // one tenant-scoped fence so a stop cannot race a new root run creation.
      await lockAdvisoryKey(
        transactionExecutor,
        `session-control:${this.tenantId}:${input.session.sessionId}`,
      );
      await assertTenantSession(
        transactionExecutor,
        this.tenantId,
        input.session.sessionId,
        true,
      );
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      if (input.leaseRootRunId) {
        await assertOwnedRunLeaseForRun(
          transactionExecutor,
          this.tenantId,
          this.ownerInstanceId,
          input.session.sessionId,
          input.leaseRootRunId,
        );
      }
      await tx.conversation.createSession(input.session);
      if (input.run.parentRunId == null) {
        const competingRoot = await transactionExecutor.query<{ run_id: string }>(
          `SELECT run_id FROM saas_runs
           WHERE tenant_id=$1 AND session_id=$2 AND parent_run_id IS NULL
             AND status IN ('running','suspended') AND run_id<>$3 LIMIT 1`,
          [this.tenantId, input.session.sessionId, input.run.runId],
        );
        if (competingRoot.rows[0]) {
          throw new Error(`session already has an active root run: ${input.session.sessionId}`);
        }
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
      if (input.claimOwnLease && input.run.parentRunId == null) {
        throw new Error("claimOwnLease is only valid for a child run");
      }
      if (input.run.parentRunId == null || input.claimOwnLease) {
        await this.claimRootRunLease(
          transactionExecutor,
          input.session.sessionId,
          input.run.runId,
        );
      }
      const records: RuntimeRecordEnvelopeResult[] = [];
      for (const record of initialRecords) {
        await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${record.outbox.eventId}`);
        records.push(await recordEnvelope(
          tx,
          transactionExecutor,
          this.tenantId,
          record,
        ));
      }
      return { run, initialUserMessage, records };
    });
  }

  private async startOrAppendRoot(input: RuntimeStartOrAppendRootInput): Promise<RuntimeStartOrAppendRootResult> {
    assertSessionId(input.run.sessionId, input.session.sessionId, "run");
    if (input.run.parentRunId != null) throw new Error("startOrAppendRoot requires a root run");
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.session.sessionId}`);
      await assertTenantSession(transactionExecutor, this.tenantId, input.session.sessionId, true);
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      await tx.conversation.createSession(input.session);
      const maintenance = await transactionExecutor.query(
        `SELECT 1 FROM conversation_sessions
         WHERE tenant_id=$1 AND session_id=$2
           AND metadata->'runtime_maintenance' IS NOT NULL
           AND metadata->'runtime_maintenance'<>'null'::jsonb
           AND NULLIF(metadata#>>'{runtime_maintenance,expires_at}', '')::timestamptz > CURRENT_TIMESTAMP
           AND metadata#>>'{runtime_maintenance,token}' IS DISTINCT FROM $3`,
        [this.tenantId, input.session.sessionId, input.sessionMaintenanceToken ?? null],
      );
      if (maintenance.rows[0]) throw new Error("session maintenance is in progress");
      const recovered = await this.recoverExpiredSessionRunLeases(
        transactionExecutor,
        input.session.sessionId,
        null,
      );
      const active = await transactionExecutor.query<{ run_id: string; owner_instance_id: string | null; status: string }>(
        `SELECT run_id, owner_instance_id, status FROM saas_runs WHERE tenant_id=$1 AND session_id=$2
         AND parent_run_id IS NULL AND status IN ('running','suspended') ORDER BY created_at DESC LIMIT 1`,
        [this.tenantId, input.session.sessionId],
      );
      const activeRunId = active.rows[0]?.run_id;
      const activeOwnedHere = active.rows[0]?.owner_instance_id === this.ownerInstanceId;
      if (activeRunId && activeRunId !== input.run.runId) {
        if (active.rows[0]?.status === "suspended") {
          return {
            kind: "followup" as const,
            activeRunId,
            ownedByCurrentInstance: activeOwnedHere,
            records: recovered.records,
          };
        }
        if (input.pendingUserMessageId) {
          return {
            kind: "followup" as const,
            activeRunId,
            ownedByCurrentInstance: activeOwnedHere,
            records: recovered.records,
          };
        }
        if (input.deferFollowup) {
          return {
            kind: "followup" as const,
            activeRunId,
            ownedByCurrentInstance: activeOwnedHere,
            records: recovered.records,
          };
        }
        if (!activeOwnedHere) {
          return {
            kind: "followup" as const,
            activeRunId,
            ownedByCurrentInstance: false,
            records: recovered.records,
          };
        }
        const stepRows = await transactionExecutor.query<{ payload: unknown }>(
          "SELECT payload FROM saas_run_steps WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3",
          [this.tenantId, input.session.sessionId, activeRunId],
        );
        const roundIndex = stepRows.rows.reduce((max, row) => {
          const round = jsonObject(jsonObject(row.payload).payload).round;
          return typeof round === "number" && round > max ? round : max;
        }, 0);
        const followup = input.followupFactory({ activeRunId, roundIndex });
        assertSessionId(followup.message.sessionId, input.session.sessionId, "followup message");
        const message = await getOrCreateMessage(transactionExecutor, tx, followup.message, "followup message");
        const records: RuntimeRecordEnvelopeResult[] = [];
        for (const record of followup.recordFactory(message)) {
          assertRecordScope(record, input.session.sessionId, activeRunId);
          await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${record.outbox.eventId}`);
          records.push(await recordEnvelope(tx, transactionExecutor, this.tenantId, normalizeRecord(record)));
        }
        return { kind: "followup", activeRunId, ownedByCurrentInstance: activeOwnedHere, message, records: [...recovered.records, ...records] };
      }
      const { followupFactory: _factory, ...start } = input;
      await lockAdvisoryKey(transactionExecutor, `run:${this.tenantId}:${start.run.runId}`);
      const existingRun = await lockTenantRun(transactionExecutor, this.tenantId, start.run.runId);
      if (existingRun) assertRunScope(existingRun, start.run);
      let initialUserMessage = start.initialUserMessage ? await getOrCreateMessage(transactionExecutor, tx, start.initialUserMessage, "initial user message") : null;
      if (start.pendingUserMessageId && initialUserMessage) {
        throw new Error("pending followup continuation cannot insert another initial user message");
      }
      const pendingRows = await transactionExecutor.query<{ id: string }>(
        `SELECT id FROM conversation_messages
         WHERE session_id=$1 AND role='user' AND metadata->>'followup_pending'='true'
         ORDER BY seq FOR UPDATE`,
        [start.session.sessionId],
      );
      if (start.pendingUserMessageId && !pendingRows.rows.some((row) => row.id === start.pendingUserMessageId)) {
        throw new Error(`pending followup is no longer available: ${start.pendingUserMessageId}`);
      }
      for (const row of pendingRows.rows) {
        const pending = await tx.conversation.getMessageById(start.session.sessionId, row.id);
        if (!pending) continue;
        const claimedMetadata = {
          ...pending.metadata,
          followup_pending: false,
          run_id: start.run.runId,
          consumed_by_run_id: start.run.runId,
          followup_continuation_trigger: pending.id === start.pendingUserMessageId,
        };
        const claimed = await transactionExecutor.query(
          `UPDATE conversation_messages
           SET metadata=$1::jsonb
           WHERE session_id=$2 AND id=$3 AND role='user'
             AND metadata->>'followup_pending'='true'`,
          [JSON.stringify(claimedMetadata), start.session.sessionId, pending.id],
        );
        if (Number(claimed.rowCount ?? 0) !== 1) {
          throw new Error(`failed to claim pending followup: ${pending.id}`);
        }
        if (pending.id === start.pendingUserMessageId) {
          initialUserMessage = { ...pending, metadata: claimedMetadata };
        }
      }
      const run = existingRun ? toCreatedRun(existingRun) : await tx.runs.createRun(start.run);
      await this.claimRootRunLease(transactionExecutor, start.session.sessionId, start.run.runId);
      if (input.sessionMaintenanceToken) {
        await transactionExecutor.query(
          `UPDATE conversation_sessions
           SET metadata=COALESCE(metadata, '{}'::jsonb) - 'runtime_maintenance', updated_at=CURRENT_TIMESTAMP
           WHERE tenant_id=$1 AND session_id=$2
             AND metadata#>>'{runtime_maintenance,token}'=$3`,
          [this.tenantId, start.session.sessionId, input.sessionMaintenanceToken],
        );
      }
      const records: RuntimeRecordEnvelopeResult[] = [...recovered.records];
      for (const record of (start.initialRecords ?? []).map(normalizeRecord)) {
        assertRecordScope(record, start.session.sessionId, start.run.runId);
        await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${record.outbox.eventId}`);
        records.push(await recordEnvelope(tx, transactionExecutor, this.tenantId, record));
      }
      return { kind: "started", run, initialUserMessage, records };
    });
  }

  private async renewRunLease(input: RuntimeRenewRunLeaseInput): Promise<RuntimeRenewRunLeaseResult> {
    const leaseMs = validateRunLeaseMs(input.leaseMs ?? this.rootLeaseMs);
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      const result = await transactionExecutor.query<{ lease_expires_at: unknown }>(
        `UPDATE saas_runs
         SET lease_expires_at=CURRENT_TIMESTAMP + ($1::bigint * INTERVAL '1 millisecond'),
             updated_at=CURRENT_TIMESTAMP
         WHERE tenant_id=$2 AND session_id=$3 AND run_id=$4
            AND status='running' AND owner_instance_id=$5
         RETURNING lease_expires_at`,
        [leaseMs, this.tenantId, input.sessionId, input.rootRunId, this.ownerInstanceId],
      );
      const expiresAt = result.rows[0]?.lease_expires_at;
      return { renewed: expiresAt != null, expiresAt: expiresAt == null ? null : iso(expiresAt) };
    });
  }

  private async recoverExpiredRunLeases(
    input: RuntimeRecoverExpiredRunLeasesInput,
  ): Promise<RuntimeRecoverExpiredRunLeasesResult> {
    const now = input.now ? new Date(input.now).toISOString() : null;
    const candidates = await this.executor.query<{ session_id: string }>(
      `SELECT DISTINCT session_id FROM saas_runs
       WHERE tenant_id=$1 AND status='running'
         AND lease_root_run_id = run_id
         AND (lease_expires_at IS NULL OR lease_expires_at <= COALESCE($2::timestamptz, CURRENT_TIMESTAMP))
       ORDER BY session_id`,
      [this.tenantId, now],
    );
    const result: RuntimeRecoverExpiredRunLeasesResult = {
      interruptedRuns: [],
      suspendedRuns: [],
      cancelledInteractions: 0,
      records: [],
    };
    for (const candidate of candidates.rows) {
      const recovered = await this.executor.transaction(async (transactionExecutor) => {
        await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${candidate.session_id}`);
        return this.recoverExpiredSessionRunLeases(
          transactionExecutor,
          candidate.session_id,
           now,
        );
      });
      result.interruptedRuns.push(...recovered.interruptedRuns);
      result.suspendedRuns.push(...recovered.suspendedRuns);
      result.cancelledInteractions += recovered.cancelledInteractions;
      result.records.push(...recovered.records);
    }
    return result;
  }

  private async recoverExpiredSessionRunLeases(
    transactionExecutor: PostgresExecutor,
    sessionId: string,
    now: string | null,
  ): Promise<RuntimeRecoverExpiredRunLeasesResult> {
    const expiredRoots = await transactionExecutor.query<{ run_id: string }>(
      `SELECT run_id FROM saas_runs
       WHERE tenant_id=$1 AND session_id=$2 AND status='running'
         AND lease_root_run_id = run_id
         AND (lease_expires_at IS NULL OR lease_expires_at <= COALESCE($3::timestamptz, CURRENT_TIMESTAMP))
       ORDER BY created_at, run_id FOR UPDATE`,
      [this.tenantId, sessionId, now],
    );
    const tx = createTransactionFacade(this.tenantId, transactionExecutor);
    const result: RuntimeRecoverExpiredRunLeasesResult = {
      interruptedRuns: [],
      suspendedRuns: [],
      cancelledInteractions: 0,
      records: [],
    };
    for (const root of expiredRoots.rows) {
      const rootRunId = String(root.run_id);
      await lockAdvisoryKey(transactionExecutor, `interaction-root:${this.tenantId}:${sessionId}:${rootRunId}`);
      let pending = await tx.pendingInteractions.listPendingInteractions({
        sessionId,
        rootRunId,
        statuses: ["waiting", "suspended", "resolved", "resuming"],
      });
      for (const batchId of new Set(
        pending.filter((interaction) => interaction.status === "resuming").map((interaction) => interaction.batch_id),
      )) {
        await tx.pendingInteractions.releasePendingBatch(sessionId, batchId);
      }
      pending = await tx.pendingInteractions.listPendingInteractions({
        sessionId,
        rootRunId,
        statuses: ["waiting", "suspended", "resolved"],
      });
      const shouldSuspend = pending.length > 0;
      if (shouldSuspend) {
        await tx.pendingInteractions.finalizePendingInteractions(sessionId, rootRunId, "suspended");
      } else {
        result.cancelledInteractions += pending.length;
        await tx.pendingInteractions.finalizePendingInteractions(sessionId, rootRunId, "interrupted");
      }
      const nextStatus = shouldSuspend ? "suspended" as const : "interrupted" as const;
      const recoveredRuns = await transactionExecutor.query<Record<string, unknown>>(
        `SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                child_agent_id, final_message_id, created_at, updated_at
         FROM saas_runs
         WHERE tenant_id=$1 AND session_id=$2 AND lease_root_run_id=$3
           AND status IN ('running','suspended')
         ORDER BY CASE WHEN run_id=$3 THEN 1 ELSE 0 END, run_id
         FOR UPDATE`,
         [this.tenantId, sessionId, rootRunId],
      );
      if (!recoveredRuns.rows.some((row) => row.run_id === rootRunId)) continue;
      if (shouldSuspend) {
        for (const row of recoveredRuns.rows) {
          if (!await tx.runs.updateRunStatus(String(row.run_id), sessionId, "suspended", null, null)) {
            throw new Error(`run not found while suspending expired lease: ${String(row.run_id)}`);
          }
        }
      }
      if (nextStatus === "interrupted") {
        for (const raw of recoveredRuns.rows) {
          const row = mapRun(raw);
          const threadKey = row.thread_key || "root";
          const messages = await tx.conversation.getRecentMessages(sessionId, 10_000, threadKey);
          const closedToolMessages: MessageInfo[] = [];
          for (const message of buildTerminalToolMessages(
            messages,
            {
              sessionId,
              runId: row.run_id,
              threadKey,
              childAgentId: row.child_agent_id,
              agentName: row.agent_name ?? row.agent_display_name,
              terminalStatus: "interrupted",
              reason: "run_lease_expired",
            },
          )) {
            closedToolMessages.push(await getOrCreateMessage(transactionExecutor, tx, message, "terminal tool message"));
          }
          const runId = row.run_id;
          const parentRunId = row.parent_run_id;
          const finalMessage = await getOrCreateMessage(
            transactionExecutor,
            tx,
            buildTerminalAssistantMessage({
              sessionId,
              runId,
              threadKey,
              childAgentId: row.child_agent_id,
              agentName: row.agent_name ?? row.agent_display_name,
              terminalStatus: "interrupted",
              reason: "run_lease_expired",
              metadata: {
                conversation_scope: parentRunId === null ? "root" : "child",
                ...(parentRunId ? { parent_run_id: parentRunId } : {}),
              },
            }),
            "terminal message",
          );
          await tx.runs.updateRunStepsMessageId(sessionId, runId, finalMessage.id);
          for (const terminalRecord of buildRunTerminalRecords({
            run: {
              sessionId,
              runId,
              agentCallId: row.agent_call_id,
              lineageParentCallId: row.lineage_parent_call_id,
              agentName: row.agent_name ?? "unknown",
              agentDisplayName: row.agent_display_name,
            },
            status: "interrupted",
            reason: "run_lease_expired",
            finalMessage,
            closedToolMessages,
          })) {
            const normalized = normalizeRecord(terminalRecord);
            assertRecordScope(normalized, sessionId, runId);
            await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${normalized.outbox.eventId}`);
            result.records.push(await recordEnvelope(tx, transactionExecutor, this.tenantId, normalized));
          }
          if (!await tx.runs.updateRunStatus(runId, sessionId, "interrupted", finalMessage.id, "run_lease_expired")) {
            throw new Error(`run not found while recovering expired lease: ${runId}`);
          }
          await tx.providerContinuations.deleteProviderContinuations(sessionId, threadKey);
        }
      }
      const projectedRuns = recoveredRuns.rows.map((row) => ({
        sessionId,
        runId: String(row.run_id),
        parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
      }));
      if (shouldSuspend) result.suspendedRuns.push(...projectedRuns);
      else result.interruptedRuns.push(...projectedRuns);
    }
    return result;
  }

  private async claimRootRunLease(
    transactionExecutor: PostgresExecutor,
    sessionId: string,
    rootRunId: string,
  ): Promise<void> {
    const result = await transactionExecutor.query<{ run_id: string }>(
      `UPDATE saas_runs
       SET owner_instance_id=$1,
           lease_expires_at=CURRENT_TIMESTAMP + ($2::bigint * INTERVAL '1 millisecond'),
           updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$3 AND session_id=$4 AND run_id=$5
          AND status='running'
         AND (owner_instance_id=$1 OR lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP)
       RETURNING run_id`,
      [this.ownerInstanceId, this.rootLeaseMs, this.tenantId, sessionId, rootRunId],
    );
    if (!result.rows[0]) throw new Error(`root run lease is owned by another instance: ${rootRunId}`);
  }

  private async recordEnvelope(input: RuntimeRecordEnvelopeInput): Promise<RuntimeRecordEnvelopeResult> {
    const normalized = normalizeRecord(input);
    assertRecordScope(normalized);
    return this.executor.transaction(async (transactionExecutor) => {
      if (normalized.requireRunLease) {
        await lockAdvisoryKey(
          transactionExecutor,
          `session-control:${this.tenantId}:${normalized.outbox.sessionId}`,
        );
      }
      await assertTenantSession(transactionExecutor, this.tenantId, normalized.outbox.sessionId);
      if (normalized.outbox.runId) {
        if (normalized.requireRunLease) {
          await assertOwnedRunLeaseForRun(
            transactionExecutor,
            this.tenantId,
            this.ownerInstanceId,
            normalized.outbox.sessionId,
            normalized.outbox.runId,
          );
        }
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
      if (input.leaseRootRunId) {
        await lockAdvisoryKey(
          transactionExecutor,
          `session-control:${this.tenantId}:${input.message.sessionId}`,
        );
      }
      await assertTenantSession(transactionExecutor, this.tenantId, input.message.sessionId);
      if (input.leaseRootRunId) {
        await assertOwnedRunLeaseForRun(
          transactionExecutor,
          this.tenantId,
          this.ownerInstanceId,
          input.message.sessionId,
          input.leaseRootRunId,
        );
      }
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
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${expected.sessionId}`);
      await assertTenantSession(transactionExecutor, this.tenantId, expected.sessionId);
      await assertOwnedRunLeaseForRun(
        transactionExecutor,
        this.tenantId,
        this.ownerInstanceId,
        expected.sessionId,
        expected.rootRunId,
      );
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
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      await lockAdvisoryKey(transactionExecutor, `interaction:${this.tenantId}:${input.interactionId}`);
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const current = await tx.pendingInteractions.getPendingInteraction(input.sessionId, input.interactionId);
      if (!current) throw new RuntimeInteractionUnavailableError("not_found", input.interactionId);
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
        throw new RuntimeInteractionUnavailableError("not_found", input.interactionId);
      }
      if (current.kind !== input.resolution.kind) {
        throw new RuntimeInteractionUnavailableError("kind_mismatch", input.interactionId);
      }
      if (current.status === "cancelled") {
        throw new RuntimeInteractionUnavailableError("cancelled", input.interactionId);
      }
      const record = input.buildRecord(current);
      assertRecordScope(record, input.sessionId, current.run_id);
      assertInteractionEnvelope(record, toCreatePendingInput(current), "responded");
      const normalized = normalizeRecord(record);
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
      if (!interaction) throw new RuntimeInteractionUnavailableError("not_found", input.interactionId);
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
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
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
      const maintenance = jsonObject(session.metadata).runtime_maintenance;
      if (jsonObject(maintenance).token && Date.parse(String(jsonObject(maintenance).expires_at ?? "")) > Date.now()) {
        return { claimed: false, reason: "already_claimed" };
      }
      if (rootRun.parent_run_id === null) {
        const competing = await transactionExecutor.query<{ run_id: string }>(
          `SELECT run_id FROM saas_runs
           WHERE tenant_id=$1 AND session_id=$2 AND parent_run_id IS NULL
             AND run_id<>$3 AND status='running' LIMIT 1`,
          [this.tenantId, input.sessionId, rootRun.run_id],
        );
        if (competing.rows[0]) return { claimed: false, reason: "already_claimed" };
      }
      const repository = new PostgresPendingInteractionRepository(transactionExecutor);
      const claimed = await repository.claimPendingBatch(
        input.sessionId,
        interaction.batch_id,
        claimId,
        resumeLeaseMs(input.leaseMs),
      );
      if (claimed !== batch.length) {
        throw new Error(`resume batch claim was partial: ${interaction.batch_id}`);
      }
      if (!await tx.runs.updateRunStatus(rootRun.run_id, input.sessionId, "running", null)) {
        throw new Error(`resume root run update failed: ${rootRun.run_id}`);
      }
      await this.claimRootRunLease(transactionExecutor, input.sessionId, rootRun.run_id);
      const request = interaction.request_payload;
      if (!rootRun.agent_name) throw new Error(`resume root run has no agent: ${rootRun.run_id}`);
      return {
        claimed: true,
        claimId,
        batchId: interaction.batch_id,
        rootRunId: rootRun.run_id,
        rootCallId: stringField(request.rootCallId) ?? `call_${rootRun.run_id}`,
        agentName: rootRun.agent_name,
        threadKey: rootRun.thread_key,
        parentRunId: rootRun.parent_run_id,
        parentCallId: rootRun.parent_call_id,
        lineageParentCallId: stringField(request.lineageParentCallId),
        childAgentId: rootRun.child_agent_id,
        workspaceRoot: stringField(request.workspaceRoot),
        task: stringField(request.task) ?? rootRun.task_summary ?? "",
        requestId: stringField(request.requestId) ?? rootRun.request_id,
        executionKind: stringField(request.executionKind) ?? rootRun.entrypoint ?? "agent_stream",
        userId: rootRun.user_id,
        sessionIdentity: toSessionIdentity(session),
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
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
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
      if (claimed.length === 0 && input.batchId) {
        await lockAdvisoryKey(
          transactionExecutor,
          `interaction-batch:${this.tenantId}:${input.sessionId}:${input.batchId}`,
        );
      }
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
      if (claimed.length === 0) {
        if (!input.batchId) return { rolledBack: false };
        const batch = await tx.pendingInteractions.listPendingInteractions({
          sessionId: input.sessionId,
          batchId: input.batchId,
        });
        if (batch.length === 0 || batch.some((item) => item.root_run_id !== input.rootRunId || item.status !== "resolved")) {
          return { rolledBack: false };
        }
        if (!await tx.runs.updateRunStatus(input.rootRunId, input.sessionId, "suspended", null)) {
          throw new Error(`attached resume rollback failed: ${input.rootRunId}`);
        }
        return { rolledBack: true };
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

  private async attachResume(input: RuntimeAttachResumeInput): Promise<RuntimeAttachResumeResult> {
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
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
      const normalized = normalizeRecord(input.record);
      assertRecordScope(normalized, input.sessionId, input.rootRunId);
      if (claimed.length === 0) {
        const batch = await tx.pendingInteractions.listPendingInteractions({
          sessionId: input.sessionId,
          batchId: input.batchId,
        });
        const alreadyAttached = batch.length > 0
          && batch.every((item) => item.root_run_id === input.rootRunId
            && (item.status === "resolved" || item.status === "consumed"));
        if (!alreadyAttached) return { attached: false, record: null };
        const rootRun = await lockTenantRun(transactionExecutor, this.tenantId, input.rootRunId);
        if (!rootRun || rootRun.session_id !== input.sessionId || rootRun.status !== "running") {
          return { attached: false, record: null };
        }
        try {
          await assertOwnedRunLeaseForRun(
            transactionExecutor,
            this.tenantId,
            this.ownerInstanceId,
            input.sessionId,
            input.rootRunId,
          );
        } catch {
          return { attached: false, record: null };
        }
        await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${normalized.outbox.eventId}`);
        const existingStep = await findEventStep(
          transactionExecutor,
          this.tenantId,
          normalized.outbox.eventId,
        );
        const existingOutbox = await findEventOutbox(
          transactionExecutor,
          this.tenantId,
          normalized.outbox.eventId,
        );
        if (!existingStep || !existingOutbox) return { attached: false, record: null };
        assertExistingRecord(normalized, existingStep, existingOutbox);
        return {
          attached: true,
          record: { step: existingStep.record, outbox: existingOutbox },
        };
      }
      for (const batchId of [...new Set(claimed.map((item) => item.batch_id))].sort()) {
        await lockAdvisoryKey(
          transactionExecutor,
          `interaction-batch:${this.tenantId}:${input.sessionId}:${batchId}`,
        );
      }
      const rootRun = await lockTenantRun(transactionExecutor, this.tenantId, input.rootRunId);
      if (!rootRun || rootRun.session_id !== input.sessionId || rootRun.status !== "running") {
        return { attached: false, record: null };
      }
      try {
        await assertOwnedRunLeaseForRun(
          transactionExecutor,
          this.tenantId,
          this.ownerInstanceId,
          input.sessionId,
          input.rootRunId,
        );
      } catch {
        return { attached: false, record: null };
      }
      const repository = new PostgresPendingInteractionRepository(transactionExecutor);
      const released = await repository.releasePendingClaim(input.sessionId, input.rootRunId, input.claimId);
      if (released !== claimed.length) throw new Error(`resume attach release was partial: ${input.claimId}`);
      await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${normalized.outbox.eventId}`);
      return {
        attached: true,
        record: await recordEnvelope(tx, transactionExecutor, this.tenantId, normalized),
      };
    });
  }

  private async interruptSession(input: RuntimeInterruptSessionInput): Promise<RuntimeInterruptSessionResult> {
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const runIds = new Set<string>();
      const activeRuns = await transactionExecutor.query<Record<string, unknown>>(
        `SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                child_agent_id, final_message_id, created_at, updated_at
         FROM saas_runs
         WHERE tenant_id=$1 AND session_id=$2 AND status IN ('running','suspended')
         ORDER BY run_id`,
        [this.tenantId, input.sessionId],
      );
      for (const row of activeRuns.rows) runIds.add(String(row.lease_root_run_id));
      const activePending = await tx.pendingInteractions.listPendingInteractions({
        sessionId: input.sessionId,
        statuses: ["waiting", "suspended", "resolved", "resuming"],
      });
      for (const pending of activePending) runIds.add(pending.root_run_id);

      const interruptedRuns: RuntimeInterruptSessionResult["interruptedRuns"] = [];
      const records: RuntimeRecordEnvelopeResult[] = [];
      let cancelledInteractions = 0;
      for (const rootRunId of [...runIds].sort()) {
        await lockAdvisoryKey(
          transactionExecutor,
          `interaction-root:${this.tenantId}:${input.sessionId}:${rootRunId}`,
        );
        const rootRun = await lockTenantRun(transactionExecutor, this.tenantId, rootRunId);
        if (rootRun && rootRun.status !== "running" && rootRun.status !== "suspended") continue;
        const rootPending = activePending.filter((pending) => pending.root_run_id === rootRunId);
        cancelledInteractions += rootPending.length;
        await tx.pendingInteractions.finalizePendingInteractions(input.sessionId, rootRunId, "interrupted");
        if (rootRun && rootRun.session_id !== input.sessionId) {
          throw new Error(`pending interaction root is invalid while interrupting session: ${rootRunId}`);
        }
      }
      for (const raw of activeRuns.rows) {
        const runId = String(raw.run_id);
        const run = await lockTenantRun(transactionExecutor, this.tenantId, runId);
        if (!run || run.session_id !== input.sessionId || (run.status !== "running" && run.status !== "suspended")) continue;
        const parentRunId = run.parent_run_id;
        const threadKey = run.thread_key || "root";
        const messages = await tx.conversation.getRecentMessages(input.sessionId, 10_000, threadKey);
        const closedToolMessages: MessageInfo[] = [];
        for (const message of buildTerminalToolMessages(
          messages,
          {
            sessionId: input.sessionId,
            runId,
            threadKey,
            childAgentId: run.child_agent_id,
            agentName: run.agent_name ?? "unknown",
            terminalStatus: "interrupted",
            reason: "session_stopped",
          },
        )) {
          closedToolMessages.push(await getOrCreateMessage(transactionExecutor, tx, message, "terminal tool message"));
        }
        const finalMessage = await getOrCreateMessage(
          transactionExecutor,
          tx,
          buildTerminalAssistantMessage({
            sessionId: input.sessionId,
            runId,
            threadKey,
            childAgentId: run.child_agent_id,
            agentName: run.agent_name ?? "unknown",
            terminalStatus: "interrupted",
            reason: "session_stopped",
            metadata: {
              conversation_scope: parentRunId === null ? "root" : "child",
              ...(parentRunId ? { parent_run_id: parentRunId } : {}),
            },
          }),
          "terminal message",
        );
        if (!await tx.runs.updateRunStatus(runId, input.sessionId, "interrupted", finalMessage.id, "session_stopped")) {
          throw new Error(`run not found while interrupting session: ${runId}`);
        }
        await tx.providerContinuations.deleteProviderContinuations(input.sessionId, threadKey);
        const interrupted = { runId, parentRunId };
        interruptedRuns.push(interrupted);
        for (const terminalRecord of buildRunTerminalRecords({
          run: {
            sessionId: input.sessionId,
            runId,
            agentCallId: run.agent_call_id,
            lineageParentCallId: run.lineage_parent_call_id,
            agentName: run.agent_name ?? "unknown",
            agentDisplayName: run.agent_display_name,
          },
          status: "interrupted",
          reason: "session_stopped",
          finalMessage,
          closedToolMessages,
        })) {
          const normalized = normalizeRecord(terminalRecord);
          assertRecordScope(normalized, input.sessionId, runId);
          await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${normalized.outbox.eventId}`);
          records.push(await recordEnvelope(tx, transactionExecutor, this.tenantId, normalized));
        }
        await tx.runs.updateRunStepsMessageId(input.sessionId, runId, finalMessage.id);
      }
      return { interruptedRuns, cancelledInteractions, records };
    });
  }

  private async recoverExpiredResumeClaims(input: RuntimeRecoverExpiredResumeClaimsInput): Promise<RuntimeRecoverExpiredResumeClaimsResult> {
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      const cutoffMs = input.now === undefined ? null : Date.parse(input.now);
      if (cutoffMs !== null && !Number.isFinite(cutoffMs)) {
        throw new Error("resume claim now must be a valid timestamp");
      }
      const cutoff = cutoffMs === null ? null : new Date(cutoffMs).toISOString();
      const stale = (await transactionExecutor.query<{
        interaction_id: string;
        root_run_id: string;
        batch_id: string;
        resume_claim_id: string | null;
        updated_at: string;
      }>(
        `SELECT interaction_id, root_run_id, batch_id, resume_claim_id, updated_at FROM pending_interactions
         WHERE session_id=$1 AND status='resuming'
           AND resume_claim_expires_at <= COALESCE($2::timestamptz, CURRENT_TIMESTAMP)
         ORDER BY root_run_id, batch_id, interaction_id FOR UPDATE`,
        [input.sessionId, cutoff],
      )).rows.map((item) => ({
        interaction_id: String(item.interaction_id),
        root_run_id: String(item.root_run_id),
        batch_id: String(item.batch_id),
        resume_claim_id: item.resume_claim_id == null ? null : String(item.resume_claim_id),
        updated_at: String(item.updated_at),
      })).filter((item) => item.resume_claim_id);
      const groups = new Map<string, typeof stale>();
      for (const item of stale) {
        const key = `${item.root_run_id}:${item.batch_id}:${item.resume_claim_id}`;
        const group = groups.get(key) ?? [];
        group.push(item);
        groups.set(key, group);
      }
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const recoveredClaimIds = new Set<string>();
      const recoveredBatchIds = new Set<string>();
      const suspendedRootRunIds = new Set<string>();
      for (const group of [...groups.values()].sort((left, right) => left[0]!.root_run_id.localeCompare(right[0]!.root_run_id) || left[0]!.batch_id.localeCompare(right[0]!.batch_id))) {
        const rootRunId = group[0]!.root_run_id;
        await lockAdvisoryKey(transactionExecutor, `interaction-root:${this.tenantId}:${input.sessionId}:${rootRunId}`);
        await lockAdvisoryKey(transactionExecutor, `interaction-batch:${this.tenantId}:${input.sessionId}:${group[0]!.batch_id}`);
        const root = await lockTenantRun(transactionExecutor, this.tenantId, rootRunId);
        if (!root || root.session_id !== input.sessionId) continue;
        if (root.status !== "running") {
          if (root.status === "completed" || root.status === "failed" || root.status === "interrupted" || root.status === "suspended") {
            await tx.pendingInteractions.finalizePendingInteractions(input.sessionId, rootRunId, root.status);
            if (root.status !== "suspended") {
              await tx.providerContinuations.deleteProviderContinuations(input.sessionId, root.thread_key || "root");
            }
            recoveredClaimIds.add(group[0]!.resume_claim_id!);
            recoveredBatchIds.add(group[0]!.batch_id);
          }
          continue;
        }
        const released = await new PostgresPendingInteractionRepository(transactionExecutor)
          .releasePendingClaim(input.sessionId, rootRunId, group[0]!.resume_claim_id!);
        if (released !== group.length) throw new Error(`resume claim recovery was partial: ${group[0]!.resume_claim_id}`);
        recoveredClaimIds.add(group[0]!.resume_claim_id!);
        recoveredBatchIds.add(group[0]!.batch_id);
        suspendedRootRunIds.add(rootRunId);
      }
      for (const rootRunId of [...suspendedRootRunIds].sort()) {
        if (!await tx.runs.updateRunStatus(rootRunId, input.sessionId, "suspended", null)) {
          throw new Error(`resume root run recovery failed: ${rootRunId}`);
        }
      }
      return {
        recoveredClaimIds: [...recoveredClaimIds].sort(),
        recoveredBatchIds: [...recoveredBatchIds].sort(),
        suspendedRootRunIds: [...suspendedRootRunIds].sort(),
      };
    });
  }

  private async finalizeRun(input: RuntimeFinalizeRunInput): Promise<RuntimeFinalizeRunResult> {
    assertTerminalMessageRule(input);
    if (input.finalMessage) {
      assertSessionId(input.finalMessage.sessionId, input.sessionId, "final message");
    }
    return this.executor.transaction(async (transactionExecutor) => {
      await lockAdvisoryKey(transactionExecutor, `session-control:${this.tenantId}:${input.sessionId}`);
      await assertTenantSession(transactionExecutor, this.tenantId, input.sessionId);
      if (input.interactionRootRunId && input.interactionRootRunId !== input.runId) {
        throw new Error(`root interaction finalization requires the root run: ${input.runId}`);
      }
      if (input.interactionRootRunId) {
        await lockAdvisoryKey(
          transactionExecutor,
          `interaction-root:${this.tenantId}:${input.sessionId}:${input.interactionRootRunId}`,
        );
      }
      const run = await lockTenantRun(transactionExecutor, this.tenantId, input.runId);
      if (!run || run.session_id !== input.sessionId) {
        throw new Error(`run not found while finalizing: ${input.runId}`);
      }
      if (input.leaseRootRunId && run.status === "running") {
        await assertOwnedRunLeaseForRun(
          transactionExecutor,
          this.tenantId,
          this.ownerInstanceId,
          input.sessionId,
          input.leaseRootRunId,
        );
      }
      if (run.status !== "running" && run.status !== input.status) {
        if (run.lease_root_run_id !== run.run_id
          && (run.status === "completed" || run.status === "failed" || run.status === "interrupted")) {
          await createTransactionFacade(this.tenantId, transactionExecutor).providerContinuations
            .deleteProviderContinuations(input.sessionId, run.thread_key || "root");
          const convergedMessage = run.final_message_id
            ? await createTransactionFacade(this.tenantId, transactionExecutor).conversation
              .getMessageById(input.sessionId, run.final_message_id)
            : null;
          return { finalMessage: convergedMessage, records: [], readyResumeInteractionIds: [] };
        }
        assertTerminalTransition(run.status, input.status, input.runId);
      }
      const terminalToolCleanup = input.closeDanglingToolCalls;
      if (terminalToolCleanup?.terminalStatus !== undefined && terminalToolCleanup.terminalStatus !== input.status) {
        throw new Error(`terminal tool status mismatch: ${input.runId}`);
      }
      if (terminalToolCleanup && input.reason != null && input.reason !== terminalToolCleanup.reason) {
        throw new Error(`terminal reason mismatch: ${input.runId}`);
      }
      const expectedTerminalReason = input.reason ?? terminalToolCleanup?.reason ?? null;
      if (run.status === input.status && run.terminal_reason !== expectedTerminalReason) {
        throw new Error(`run terminal reason conflicts with idempotent finalize: ${input.runId}`);
      }
      const tx = createTransactionFacade(this.tenantId, transactionExecutor);
      const readyResumeInteractionIds = input.interactionRootRunId
        ? await tx.pendingInteractions.finalizePendingInteractions(
            input.sessionId,
            input.interactionRootRunId,
            input.status,
          )
        : [];
      if (input.status === "suspended") {
        if (run.status === "running"
          && !await tx.runs.updateRunStatus(input.runId, input.sessionId, "suspended", null, null)) {
          throw new Error(`run not found while suspending: ${input.runId}`);
        }
        return { finalMessage: null, records: [], readyResumeInteractionIds };
      }
      const records: RuntimeRecordEnvelopeResult[] = [];
      const scopedRuns = run.lease_root_run_id === run.run_id
        ? (await transactionExecutor.query<Record<string, unknown>>(
            `SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                    request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                    agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                    child_agent_id, final_message_id, created_at, updated_at
             FROM saas_runs
             WHERE tenant_id=$1 AND session_id=$2 AND lease_root_run_id=$3
               AND (run_id=$4 OR status IN ('running','suspended'))
             ORDER BY CASE WHEN run_id=$4 THEN 1 ELSE 0 END, run_id
             FOR UPDATE`,
            [this.tenantId, input.sessionId, run.lease_root_run_id, input.runId],
          )).rows.map(mapRun)
        : [run];
      let requestedFinalMessage: MessageInfo | null = null;
      for (const scopedRun of scopedRuns) {
        const isRequestedRun = scopedRun.run_id === input.runId;
        const runStatus = isRequestedRun ? input.status : (input.status === "completed" ? "failed" as const : input.status);
        const runReason = isRequestedRun ? expectedTerminalReason : (expectedTerminalReason ?? "parent_run_terminated");
        const threadKey = scopedRun.thread_key || "root";
        await tx.providerContinuations.deleteProviderContinuations(input.sessionId, threadKey);
        const messages = await tx.conversation.getRecentMessages(input.sessionId, 10_000, threadKey);
        const closedToolMessages: MessageInfo[] = [];
        if (runStatus === "failed" || runStatus === "interrupted") {
          for (const message of buildTerminalToolMessages(messages, {
            sessionId: input.sessionId,
            runId: scopedRun.run_id,
            threadKey,
            childAgentId: scopedRun.child_agent_id,
            agentName: scopedRun.agent_name ?? scopedRun.agent_display_name,
            terminalStatus: runStatus,
            reason: runReason ?? "未提供终止原因",
          })) {
            closedToolMessages.push(await getOrCreateMessage(transactionExecutor, tx, message, "terminal tool message"));
          }
        }
        const finalMessage = isRequestedRun
          ? (input.finalMessage
              ? await getOrCreateMessage(transactionExecutor, tx, input.finalMessage, "final message")
              : null)
          : await getOrCreateMessage(transactionExecutor, tx, buildTerminalAssistantMessage({
              sessionId: input.sessionId,
              runId: scopedRun.run_id,
              threadKey,
              childAgentId: scopedRun.child_agent_id,
              agentName: scopedRun.agent_name ?? scopedRun.agent_display_name,
              terminalStatus: runStatus === "failed" ? "failed" : "interrupted",
              reason: runReason ?? "parent_run_terminated",
              metadata: {
                conversation_scope: scopedRun.parent_run_id === null ? "root" : "child",
                ...(scopedRun.parent_run_id ? { parent_run_id: scopedRun.parent_run_id } : {}),
              },
            }), "terminal message");
        if (isRequestedRun) requestedFinalMessage = finalMessage;
        if (scopedRun.status === runStatus && scopedRun.final_message_id !== (finalMessage?.id ?? null)) {
          throw new Error(`run final message conflicts with idempotent finalize: ${scopedRun.run_id}`);
        }
        for (const record of buildRunTerminalRecords({
          run: {
            sessionId: input.sessionId,
            runId: scopedRun.run_id,
            agentCallId: scopedRun.agent_call_id,
            lineageParentCallId: scopedRun.lineage_parent_call_id,
            agentName: scopedRun.agent_name ?? "unknown",
            agentDisplayName: scopedRun.agent_display_name,
          },
          status: runStatus,
          ...(runReason ? { reason: runReason } : {}),
          finalMessage,
          closedToolMessages,
        })) {
          const normalized = normalizeRecord(record);
          assertRecordScope(normalized, input.sessionId, scopedRun.run_id);
          await lockAdvisoryKey(transactionExecutor, `event:${this.tenantId}:${normalized.outbox.eventId}`);
          records.push(await recordEnvelope(tx, transactionExecutor, this.tenantId, normalized));
        }
        if (finalMessage && input.attachStepsToFinalMessage !== false) {
          await tx.runs.updateRunStepsMessageId(input.sessionId, scopedRun.run_id, finalMessage.id);
        }
        if (scopedRun.status === "running" || scopedRun.status === "suspended") {
          if (!await tx.runs.updateRunStatus(scopedRun.run_id, input.sessionId, runStatus, finalMessage?.id ?? null, runReason)) {
            throw new Error(`run not found while finalizing: ${scopedRun.run_id}`);
          }
        }
      }
      return { finalMessage: requestedFinalMessage, records, readyResumeInteractionIds };
    });
  }
}

async function recordEnvelope(
  tx: RuntimeStorageRepositories,
  executor: PostgresExecutor,
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

async function lockAdvisoryKey(executor: PostgresExecutor, key: string): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

async function assertTenantSession(
  executor: PostgresExecutor,
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
  executor: PostgresExecutor,
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
  // An independently leased background child is its own interaction recovery root
  // while retaining parent_run_id for execution-tree lineage.
}

async function lockTenantRun(
  executor: PostgresExecutor,
  tenantId: TenantId,
  runId: string,
): Promise<RunInfo | null> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
      request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
      agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
      child_agent_id, final_message_id, created_at, updated_at
     FROM saas_runs WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [tenantId, runId],
  );
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

async function assertOwnedRunLeaseForRun(
  executor: PostgresExecutor,
  tenantId: TenantId,
  ownerInstanceId: string,
  sessionId: string,
  runId: string,
): Promise<void> {
  const run = await lockTenantRun(executor, tenantId, runId);
  if (!run || run.session_id !== sessionId) throw new Error(`run not found while checking lease: ${runId}`);
  const lease = await executor.query<{ run_id: string; owned: boolean }>(
    `SELECT run_id, (owner_instance_id=$4 AND lease_expires_at > CURRENT_TIMESTAMP) AS owned
     FROM saas_runs
     WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND status='running'
     FOR UPDATE`,
    [tenantId, sessionId, run.lease_root_run_id, ownerInstanceId],
  );
  if (lease.rows[0]?.owned === true) return;
  throw new Error(`run lease was lost: ${runId}`);
}

function assertRunScope(existing: RunInfo, expected: RuntimeStartRunInput["run"]): void {
  const conflicts = [
    ["session", existing.session_id, expected.sessionId],
    ["thread", existing.thread_key, expected.threadKey?.trim() || "root"],
    ["parent run", existing.parent_run_id, expected.parentRunId ?? null],
    ["parent call", existing.parent_call_id, expected.parentCallId ?? null],
    ["child agent", existing.child_agent_id, expected.childAgentId ?? null],
    ["agent", existing.agent_name, expected.agentName ?? null],
    ["agent call", existing.agent_call_id, expected.agentCallId],
    ["lineage parent call", existing.lineage_parent_call_id, expected.lineageParentCallId],
    ["agent display name", existing.agent_display_name, expected.agentDisplayName],
    ["lease root", existing.lease_root_run_id, expected.leaseRootRunId],
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
    agent_call_id: run.agent_call_id,
    lineage_parent_call_id: run.lineage_parent_call_id,
    agent_display_name: run.agent_display_name,
    lease_root_run_id: run.lease_root_run_id,
    child_agent_id: run.child_agent_id,
  };
}

function assertTerminalTransition(current: string, target: string, runId: string): void {
  if (current === "running" || current === target) return;
  throw new Error(`run terminal status conflict: ${runId} is ${current}, cannot become ${target}`);
}

async function getOrCreateMessage(
  executor: PostgresExecutor,
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
    && jsonEqual(existing.content_parts, expected.contentParts)
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
  executor: PostgresExecutor,
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
  executor: PostgresExecutor,
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
  if (input.status !== "suspended" && !input.finalMessage) {
    throw new Error(`${input.status} finalize requires a terminal message`);
  }
  if (input.status === "suspended" && input.finalMessage) {
    throw new Error("suspended finalize must not include a final message");
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

function resumeLeaseMs(value: number | undefined): number {
  const leaseMs = value ?? 120_000;
  if (!Number.isFinite(leaseMs) || leaseMs < 1 || leaseMs > 86_400_000) {
    throw new Error("resume leaseMs must be between 1 and 86400000 milliseconds");
  }
  return Math.trunc(leaseMs);
}

function validateRunLeaseMs(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > 86_400_000) {
    throw new Error("run leaseMs must be between 1 and 86400000 milliseconds");
  }
  return Math.trunc(value);
}

function validateMaintenanceTtlMs(value: number | undefined): number {
  const ttl = value ?? 300_000;
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 3_600_000) {
    throw new Error("session maintenance ttlMs must be between 1 and 3600000 milliseconds");
  }
  return Math.trunc(ttl);
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
    terminal_reason: nullable(row.terminal_reason),
    request_id: nullable(row.request_id), user_id: nullable(row.user_id), agent_name: nullable(row.agent_name),
    agent_call_id: String(row.agent_call_id), lineage_parent_call_id: nullable(row.lineage_parent_call_id),
    agent_display_name: String(row.agent_display_name), lease_root_run_id: String(row.lease_root_run_id),
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
