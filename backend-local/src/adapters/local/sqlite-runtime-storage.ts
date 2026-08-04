import { isDeepStrictEqual } from "node:util";

import type { ConversationStore, ConversationStoreTransaction } from "./sqlite/conversation-store/index.js";
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
  RuntimeResolveInteractionInput,
  RuntimeResolveInteractionResult,
  RuntimeRollbackResumeInput,
  RuntimeRollbackResumeResult,
  RuntimeStartRunInput,
  RuntimeStartRunResult,
  RuntimeStartOrAppendRootInput,
  RuntimeStartOrAppendRootResult,
  RuntimeStorage,
  RuntimeSessionMaintenanceInput,
  RuntimeSessionFacts,
} from "@ragsystem/backend-core/contracts/storage/runtime-storage.js";
import { buildTerminalToolMessages } from "@ragsystem/backend-core/contracts/storage/runtime-finalization.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import {
  toSessionIdentity,
  type MessageInfo,
  type SessionListCursor,
  type SessionListProjection,
} from "@ragsystem/backend-core/contracts/session/session.js";

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
      getActiveRootRun: (sessionId) => this.getActiveRootRun(sessionId),
      getSessionRuntimeFacts: (sessionId) => this.getSessionRuntimeFacts(sessionId),
      consumePendingFollowups: (input) => this.consumePendingFollowups(input),
      claimSessionMaintenance: (input) => this.claimSessionMaintenance(input),
      renewSessionMaintenance: (input) => this.renewSessionMaintenance(input),
      releaseSessionMaintenance: (input) => this.releaseSessionMaintenance(input),
      finalizeRun: (input) => this.finalizeRun(input),
    };
  }

  private getActiveRootRun(sessionId: string): Promise<{ runId: string | null }> {
    return this.serial.run(() => {
      const activeRoots = this.store.listActiveRootRuns(sessionId, 2);
      if (activeRoots.length > 1) throw new Error(`session has multiple active root runs: ${sessionId}`);
      const active = activeRoots[0];
      return { runId: active?.run_id ?? null };
    });
  }

  private getSessionRuntimeFacts(sessionId: string): Promise<RuntimeSessionFacts> {
    return this.serial.run(() => {
      const session = this.store.getSession(sessionId);
      if (!session || session.tenant_id !== this.tenantId) {
        return {
          session: null,
          activeRootRun: null,
          latestTerminalRootRun: null,
          pendingInteractions: [],
          activeRunEvents: [],
          ownedByCurrentInstance: false,
        };
      }
      const activeRoots = this.store.listActiveRootRuns(sessionId, 2);
      if (activeRoots.length > 1) {
        throw new Error(`session has multiple active root runs: ${sessionId}`);
      }
      const pendingInteractions = this.store.listPendingInteractions({
        sessionId,
        statuses: ["waiting", "suspended", "resolved", "resuming"],
      });
      const interactionRootIds = new Set(pendingInteractions.map((item) => item.root_run_id));
      const runs = this.store.listRuns(sessionId, Number.MAX_SAFE_INTEGER).items;
      const activeRootRun = activeRoots[0]
        ?? runs.find((run) =>
          interactionRootIds.has(run.run_id) && (run.status === "running" || run.status === "suspended")
        )
        ?? null;
      const activeRunIds = activeRootRun ? collectRunTreeIds(runs, activeRootRun.run_id) : [];
      return {
        session,
        activeRootRun,
        latestTerminalRootRun: this.store.getLatestTerminalRootRun(sessionId),
        pendingInteractions,
        activeRunEvents: activeRunIds.length > 0
          ? loadActiveRunEvents((input) => this.store.listOutboxForReplay(input), sessionId, activeRunIds)
          : [],
        ownedByCurrentInstance: activeRootRun?.status === "running",
      };
    });
  }

  private consumePendingFollowups(
    input: RuntimeConsumePendingFollowupsInput,
  ): Promise<RuntimeConsumePendingFollowupsResult> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      const active = tx.getRun(input.sessionId, input.rootRunId);
      if (!active || active.parent_run_id !== null || active.status !== "running") {
        throw new Error(`active root run not found while consuming followups: ${input.rootRunId}`);
      }
      const messages: MessageInfo[] = [];
      for (const messageId of input.messageIds) {
        const pending = tx.getMessageById(input.sessionId, messageId);
        if (!pending || pending.role !== "user" || asRecord(pending.metadata).followup_pending !== true) continue;
        const metadata = {
          ...pending.metadata,
          followup_pending: false,
          run_id: input.rootRunId,
          consumed_by_run_id: input.rootRunId,
          followup_continuation_trigger: false,
        };
        if (!tx.updateMessage({
          messageId,
          sessionId: input.sessionId,
          roleFilter: "user",
          metadata,
        })) {
          throw new Error(`failed to consume pending followup: ${messageId}`);
        }
        messages.push({ ...pending, metadata });
      }
      return { messages };
    }));
  }

  private claimSessionMaintenance(
    input: RuntimeSessionMaintenanceInput,
  ): Promise<RuntimeClaimSessionMaintenanceResult> {
    const ttlMs = maintenanceTtlMs(input.ttlMs);
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      const session = tx.getSession(input.sessionId);
      if (!session) return { claimed: false, activeRunId: null };
      const active = tx.listRuns(input.sessionId, Number.MAX_SAFE_INTEGER).items
        .find((run) => run.status === "running" || run.status === "suspended");
      if (active) return { claimed: false, activeRunId: active.run_id };
      const maintenance = activeMaintenance(session.metadata);
      if (maintenance && maintenance.token !== input.token) {
        return { claimed: false, activeRunId: null };
      }
      tx.updateSessionMetadata(input.sessionId, {
        runtime_maintenance: {
          token: input.token,
          kind: input.kind,
          expires_at: new Date(Date.now() + ttlMs).toISOString(),
        },
      });
      return { claimed: true, activeRunId: null };
    }));
  }

  private releaseSessionMaintenance(input: { sessionId: string; token: string }): Promise<void> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      const session = tx.getSession(input.sessionId);
      const maintenance = session ? activeMaintenance(session.metadata, true) : null;
      if (maintenance?.token === input.token) {
        tx.updateSessionMetadata(input.sessionId, { runtime_maintenance: null });
      }
    }));
  }

  private renewSessionMaintenance(input: { sessionId: string; token: string; ttlMs?: number }): Promise<boolean> {
    const ttlMs = maintenanceTtlMs(input.ttlMs);
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      const session = tx.getSession(input.sessionId);
      const maintenance = session ? activeMaintenance(session.metadata, true) : null;
      if (maintenance?.token !== input.token) return false;
      tx.updateSessionMetadata(input.sessionId, {
        runtime_maintenance: {
          ...asRecord(session?.metadata.runtime_maintenance),
          token: input.token,
          expires_at: new Date(Date.now() + ttlMs).toISOString(),
        },
      });
      return true;
    }));
  }

  /**
   * Local runtime 是单进程所有者；容器刚创建时仍为 running 的 run 只可能来自上个已退出进程。
   * 在接受新消息前将它们收敛为 interrupted，并产生 durable run_ended 供重连客户端恢复。
   */
  recoverOrphanedRuns(
    buildRunEndedRecord: (run: {
      sessionId: string;
      runId: string;
      parentRunId: string | null;
      status: "interrupted" | "suspended";
      reason: "backend_restarted" | "backend_restarted_waiting_interaction";
    }) => RuntimeRecordEnvelopeInput,
  ): Promise<RuntimeInterruptSessionResult & {
    suspendedRuns: Array<{ runId: string; parentRunId: string | null }>;
  }> {
    return this.serial.run(() => {
      const sessions: SessionListProjection[] = [];
      let cursor: SessionListCursor | null = null;
      do {
        const page = this.store.listSessions({
          tenantId: this.tenantId,
          access: { userId: "usr_system", includeTenant: true, includeAll: true },
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        sessions.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      const interruptedRuns: RuntimeInterruptSessionResult["interruptedRuns"] = [];
      const suspendedRuns: Array<{ runId: string; parentRunId: string | null }> = [];
      const records: RuntimeRecordEnvelopeResult[] = [];
      let cancelledInteractions = 0;
      for (const session of sessions) {
        const recovered = this.store.runInTransaction((tx) => {
          const activeRuns = tx.listRuns(session.session_id, Number.MAX_SAFE_INTEGER).items
            .filter((run) => run.status === "running")
            .sort((left, right) => left.run_id.localeCompare(right.run_id));
          if (activeRuns.length === 0) {
            return { interruptedRuns: [], suspendedRuns: [], cancelledInteractions: 0, records: [] };
          }
          const activeById = new Map(activeRuns.map((run) => [run.run_id, run]));
          // A background child owns its interaction root. If its parent root
          // is still running, the child must be recovered separately; if the
          // parent already finished, the child is the only recovery root left.
          const pendingRootIds = new Set(
            tx.listPendingInteractions({
              sessionId: session.session_id,
              statuses: ["waiting", "suspended", "resolved", "resuming"],
            }).map((interaction) => interaction.root_run_id),
          );
          const recoveryRootRuns = activeRuns
            .filter((run) => run.parent_run_id === null || pendingRootIds.has(run.run_id))
            .sort((left, right) => {
              const leftIndependent = pendingRootIds.has(left.run_id) ? 0 : 1;
              const rightIndependent = pendingRootIds.has(right.run_id) ? 0 : 1;
              return leftIndependent - rightIndependent || left.run_id.localeCompare(right.run_id);
            });
          let sessionCancelledInteractions = 0;
          const sessionInterruptedRuns: RuntimeInterruptSessionResult["interruptedRuns"] = [];
          const sessionSuspendedRuns: Array<{ runId: string; parentRunId: string | null }> = [];
          const sessionRecords: RuntimeRecordEnvelopeResult[] = [];
          for (const recoveryRoot of recoveryRootRuns) {
            const rootRunId = recoveryRoot.run_id;
            let pending = tx.listPendingInteractions({
              sessionId: session.session_id,
              rootRunId,
              statuses: ["waiting", "suspended", "resolved", "resuming"],
            });
            for (const batchId of new Set(
              pending.filter((interaction) => interaction.status === "resuming").map((interaction) => interaction.batch_id),
            )) {
              tx.releasePendingBatch(session.session_id, batchId);
            }
            pending = tx.listPendingInteractions({
              sessionId: session.session_id,
              rootRunId,
              statuses: ["waiting", "suspended", "resolved"],
            });
            const shouldSuspend = pending.length > 0;
            const nextStatus = shouldSuspend ? "suspended" as const : "interrupted" as const;
            if (shouldSuspend) {
              tx.finalizePendingInteractions(session.session_id, rootRunId, "suspended");
            } else {
              sessionCancelledInteractions += pending.length;
              tx.finalizePendingInteractions(session.session_id, rootRunId, "interrupted");
            }
            const treeRuns = activeRuns.filter((run) => runBelongsToRoot(
              run.run_id,
              rootRunId,
              activeById,
              pendingRootIds,
            ));
            for (const run of treeRuns) {
              if (!tx.updateRunStatus(run.run_id, session.session_id, nextStatus, null)) {
                throw new Error(`orphaned run not found while recovering session: ${run.run_id}`);
              }
              if (nextStatus === "interrupted") {
                const threadKey = run.thread_key || "root";
                for (const message of buildTerminalToolMessages(
                  tx.getRecentMessages(session.session_id, Number.MAX_SAFE_INTEGER, threadKey),
                  {
                    sessionId: session.session_id,
                    runId: run.run_id,
                    threadKey,
                    agentName: run.agent_name ?? "unknown",
                    terminalStatus: "interrupted",
                    reason: "backend_restarted",
                  },
                )) {
                  resolveDeterministicMessage(tx, message, "terminal tool message");
                }
              }
              const recoveredRun = { runId: run.run_id, parentRunId: run.parent_run_id };
              if (shouldSuspend) sessionSuspendedRuns.push(recoveredRun);
              else sessionInterruptedRuns.push(recoveredRun);
            }
            sessionRecords.push(recordEnvelope(tx, buildRunEndedRecord({
                sessionId: session.session_id,
                runId: rootRunId,
                parentRunId: recoveryRoot.parent_run_id,
                status: nextStatus,
                reason: shouldSuspend
                  ? "backend_restarted_waiting_interaction"
                  : "backend_restarted",
              })));
          }
          return {
            interruptedRuns: sessionInterruptedRuns,
            suspendedRuns: sessionSuspendedRuns,
            cancelledInteractions: sessionCancelledInteractions,
            records: sessionRecords,
          };
        });
        interruptedRuns.push(...recovered.interruptedRuns);
        suspendedRuns.push(...recovered.suspendedRuns);
        cancelledInteractions += recovered.cancelledInteractions;
        records.push(...recovered.records);
      }
      return { interruptedRuns, suspendedRuns, cancelledInteractions, records };
    });
  }

  private startRun(input: RuntimeStartRunInput): Promise<RuntimeStartRunResult> {
    return this.serial.run(() => {
      assertSessionId(input.run.sessionId, input.session.sessionId, "run");
      if (input.initialUserMessage) {
        assertSessionId(input.initialUserMessage.sessionId, input.session.sessionId, "initial user message");
      }
      const initialRecords = input.initialRecords ?? [];
      for (const record of initialRecords) {
        assertRecordScope(record, input.session.sessionId, input.run.runId);
      }
      return this.store.runInTransaction((tx) => {
        const existingSession = tx.getSession(input.session.sessionId);
        if (existingSession && existingSession.tenant_id !== this.tenantId) {
          throw new Error(`session belongs to another tenant: ${input.session.sessionId}`);
        }
        tx.createSession({
          tenantId: this.tenantId,
          ...input.session,
        });
        const existingRun = tx.getRun(input.session.sessionId, input.run.runId);
        const initialUserMessage = input.initialUserMessage
          ? resolveDeterministicMessage(tx, input.initialUserMessage, "initial user message")
          : null;
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
        if (input.claimOwnLease && input.run.parentRunId == null) {
          throw new Error("claimOwnLease is only valid for a child run");
        }
        const records = initialRecords.map((record) => recordEnvelope(tx, record));
        return { run, initialUserMessage, records };
      });
    });
  }

  private startOrAppendRoot(input: RuntimeStartOrAppendRootInput): Promise<RuntimeStartOrAppendRootResult> {
    return this.serial.run(() => {
      assertSessionId(input.run.sessionId, input.session.sessionId, "run");
      if (input.run.parentRunId != null) throw new Error("startOrAppendRoot requires a root run");
      return this.store.runInTransaction((tx) => {
        const existingSession = tx.getSession(input.session.sessionId);
        if (existingSession && existingSession.tenant_id !== this.tenantId) throw new Error(`session belongs to another tenant: ${input.session.sessionId}`);
        tx.createSession({ tenantId: this.tenantId, ...input.session });
        const session = tx.getSession(input.session.sessionId);
        const maintenance = session ? activeMaintenance(session.metadata) : null;
        if (maintenance && maintenance.token !== input.sessionMaintenanceToken) {
          throw new Error("session maintenance is in progress");
        }
        const activeRoots = tx.listActiveRootRuns(input.session.sessionId, 2);
        if (activeRoots.length > 1) throw new Error(`session has multiple active root runs: ${input.session.sessionId}`);
        const activeRoot = activeRoots[0];
        if (activeRoot && activeRoot.run_id !== input.run.runId) {
          if (activeRoot.status === "suspended") {
            return { kind: "followup" as const, activeRunId: activeRoot.run_id, ownedByCurrentInstance: true };
          }
          if (input.pendingUserMessageId) {
            return { kind: "followup" as const, activeRunId: activeRoot.run_id, ownedByCurrentInstance: true };
          }
          if (input.deferFollowup) {
            return { kind: "followup" as const, activeRunId: activeRoot.run_id, ownedByCurrentInstance: true };
          }
          const roundIndex = tx.getRecentMessages(input.session.sessionId, 1000, "root").reduce((max, message) => {
            const round = asRecord(message.metadata).round;
            return typeof round === "number" && round > max ? round : max;
          }, 0);
          const followup = input.followupFactory({ activeRunId: activeRoot.run_id, roundIndex });
          assertSessionId(followup.message.sessionId, input.session.sessionId, "followup message");
          const message = resolveDeterministicMessage(tx, followup.message, "followup message");
          const records = followup.recordFactory(message).map((record) => {
            assertRecordScope(record, input.session.sessionId, activeRoot.run_id);
            return recordEnvelope(tx, record);
          });
          return { kind: "followup", activeRunId: activeRoot.run_id, ownedByCurrentInstance: true, message, records };
        }
        const { followupFactory: _factory, ...start } = input;
        const initialRecords = start.initialRecords ?? [];
        for (const record of initialRecords) assertRecordScope(record, start.session.sessionId, start.run.runId);
        let initialUserMessage = start.initialUserMessage ? resolveDeterministicMessage(tx, start.initialUserMessage, "initial user message") : null;
        const pendingMessages = tx.getRecentMessages(start.session.sessionId, Number.MAX_SAFE_INTEGER, "root")
          .filter((message) => message.role === "user" && asRecord(message.metadata).followup_pending === true);
        if (start.pendingUserMessageId && initialUserMessage) {
          throw new Error("pending followup continuation cannot insert another initial user message");
        }
        if (start.pendingUserMessageId && !pendingMessages.some((message) => message.id === start.pendingUserMessageId)) {
          throw new Error(`pending followup is no longer available: ${start.pendingUserMessageId}`);
        }
        for (const pending of pendingMessages) {
          const claimedMetadata = {
            ...pending.metadata,
            followup_pending: false,
            run_id: start.run.runId,
            consumed_by_run_id: start.run.runId,
            followup_continuation_trigger: pending.id === start.pendingUserMessageId,
          };
          if (!tx.updateMessage({
            messageId: pending.id,
            sessionId: start.session.sessionId,
            roleFilter: "user",
            metadata: claimedMetadata,
          })) {
            throw new Error(`failed to claim pending followup: ${pending.id}`);
          }
          if (pending.id === start.pendingUserMessageId) {
            initialUserMessage = { ...pending, metadata: claimedMetadata };
          }
        }
        const existingRun = tx.getRun(start.session.sessionId, start.run.runId);
        const run = existingRun ? toCreatedRun(existingRun) : tx.createRun(start.run);
        if (existingRun) assertRunScope(existingRun, start.run, this.tenantId);
        if (maintenance?.token === input.sessionMaintenanceToken) {
          tx.updateSessionMetadata(start.session.sessionId, { runtime_maintenance: null });
        }
        return { kind: "started", run, initialUserMessage, records: initialRecords.map((record) => recordEnvelope(tx, record)) };
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
        if (activeMaintenance(session.metadata)) {
          return { claimed: false, reason: "already_claimed" };
        }
        if (rootRun.parent_run_id === null) {
          const competingRoot = tx.listActiveRootRuns(input.sessionId, 2).find((run) =>
            run.run_id !== rootRun.run_id && run.status === "running"
          );
          if (competingRoot) return { claimed: false, reason: "already_claimed" };
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
    });
  }

  private rollbackResume(input: RuntimeRollbackResumeInput): Promise<RuntimeRollbackResumeResult> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      assertTenantSession(tx, this.tenantId, input.sessionId);
      const claimed = tx.listPendingInteractions({ sessionId: input.sessionId, rootRunId: input.rootRunId })
        .filter((item) => item.status === "resuming" && item.resume_claim_id === input.claimId);
      const rootRun = tx.getRun(input.sessionId, input.rootRunId);
      if (!rootRun || rootRun.status !== "running") return { rolledBack: false };
      if (claimed.length === 0) {
        if (!input.batchId) return { rolledBack: false };
        const batch = tx.listPendingInteractions({ sessionId: input.sessionId, batchId: input.batchId });
        if (batch.length === 0 || batch.some((item) => item.root_run_id !== input.rootRunId || item.status !== "resolved")) {
          return { rolledBack: false };
        }
        if (!tx.updateRunStatus(input.rootRunId, input.sessionId, "suspended", null)) {
          throw new Error(`attached resume rollback failed: ${input.rootRunId}`);
        }
        return { rolledBack: true };
      }
      const released = tx.releasePendingClaim(input.sessionId, input.rootRunId, input.claimId);
      if (released !== claimed.length) throw new Error(`resume claim rollback was partial: ${input.claimId}`);
      if (!tx.updateRunStatus(input.rootRunId, input.sessionId, "suspended", null)) {
        throw new Error(`resume root run rollback failed: ${input.rootRunId}`);
      }
      return { rolledBack: true };
    }));
  }

  private attachResume(input: RuntimeAttachResumeInput): Promise<RuntimeAttachResumeResult> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      assertTenantSession(tx, this.tenantId, input.sessionId);
      assertRecordScope(input.record, input.sessionId, input.rootRunId);
      const claimed = tx.listPendingInteractions({ sessionId: input.sessionId, rootRunId: input.rootRunId })
        .filter((item) => item.status === "resuming" && item.resume_claim_id === input.claimId);
      const rootRun = tx.getRun(input.sessionId, input.rootRunId);
      if (claimed.length === 0) {
        const batch = tx.listPendingInteractions({ sessionId: input.sessionId, batchId: input.batchId });
        const alreadyAttached = batch.length > 0
          && batch.every((item) => item.root_run_id === input.rootRunId
            && (item.status === "resolved" || item.status === "consumed"));
        const attachEventExists = tx.getRunStepByEventId(input.record.outbox.eventId) !== null;
        if (!alreadyAttached || rootRun?.status !== "running" || !attachEventExists) {
          return { attached: false, record: null };
        }
        return { attached: true, record: recordEnvelope(tx, input.record) };
      }
      if (!rootRun || rootRun.status !== "running") return { attached: false, record: null };
      const released = tx.releasePendingClaim(input.sessionId, input.rootRunId, input.claimId);
      if (released !== claimed.length) throw new Error(`resume attach release was partial: ${input.claimId}`);
      return { attached: true, record: recordEnvelope(tx, input.record) };
    }));
  }

  private interruptSession(input: RuntimeInterruptSessionInput): Promise<RuntimeInterruptSessionResult> {
    return this.serial.run(() => this.store.runInTransaction((tx) => {
      assertTenantSession(tx, this.tenantId, input.sessionId);
      const activeRuns = tx.listRuns(input.sessionId, Number.MAX_SAFE_INTEGER).items
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
        const threadKey = run.thread_key || "root";
        for (const message of buildTerminalToolMessages(
          tx.getRecentMessages(input.sessionId, Number.MAX_SAFE_INTEGER, threadKey),
          {
            sessionId: input.sessionId,
            runId: run.run_id,
            threadKey,
            agentName: run.agent_name ?? "unknown",
            terminalStatus: "interrupted",
            reason: "session_stopped",
          },
        )) {
          resolveDeterministicMessage(tx, message, "terminal tool message");
        }
        const interrupted = { runId: run.run_id, parentRunId: run.parent_run_id };
        interruptedRuns.push(interrupted);
        if (rootRunIds.has(run.run_id)) records.push(recordEnvelope(tx, input.buildRunEndedRecord(interrupted)));
      }
      return { interruptedRuns, cancelledInteractions, records };
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
        const closedToolMessages: MessageInfo[] = [];
        const terminalToolCleanup = input.closeDanglingToolCalls;
        if (terminalToolCleanup) {
          if (terminalToolCleanup.terminalStatus !== input.status) {
            throw new Error(`terminal tool status mismatch: ${input.runId}`);
          }
          const messages = tx.getRecentMessages(
            input.sessionId,
            Number.MAX_SAFE_INTEGER,
            terminalToolCleanup.threadKey,
          );
          closedToolMessages.push(...messages.filter((message) => (
            message.role === "tool"
            && message.metadata.run_id === input.runId
            && message.metadata.terminal_tool_result === true
            && message.metadata.terminal_status === terminalToolCleanup.terminalStatus
          )));
          for (const message of buildTerminalToolMessages(messages, {
            sessionId: input.sessionId,
            runId: input.runId,
            ...terminalToolCleanup,
          })) {
            closedToolMessages.push(resolveDeterministicMessage(tx, message, "terminal tool message"));
          }
        }
        const finalMessage = resolveFinalMessage(tx, input, currentRun, replayingTerminal);
        const records: RuntimeRecordEnvelopeResult[] = [];
        for (const terminalRecord of input.buildTerminalRecords?.(finalMessage, closedToolMessages) ?? []) {
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

function collectRunTreeIds(runs: readonly { run_id: string; parent_run_id: string | null }[], rootRunId: string): string[] {
  const children = new Map<string, string[]>();
  for (const run of runs) {
    if (!run.parent_run_id) continue;
    const current = children.get(run.parent_run_id) ?? [];
    current.push(run.run_id);
    children.set(run.parent_run_id, current);
  }
  const result: string[] = [];
  const pending = [rootRunId];
  while (pending.length > 0) {
    const runId = pending.shift();
    if (!runId) continue;
    result.push(runId);
    pending.push(...(children.get(runId) ?? []));
  }
  return result;
}

function loadActiveRunEvents(
  load: (input: { sessionId: string; runIds: readonly string[]; limit: number; latest: true; eventTypes: readonly string[] }) => import("@ragsystem/backend-core/contracts/conversation-store/index.js").OutboxRow[],
  sessionId: string,
  runIds: readonly string[],
): import("@ragsystem/backend-core/contracts/conversation-store/index.js").OutboxRow[] {
  const lifecycle = load({
    sessionId,
    runIds,
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
  });
  const streams = load({
    sessionId,
    runIds,
    limit: 100,
    latest: true,
    eventTypes: ["client.stream_output"],
  });
  return [...lifecycle, ...streams].sort((left, right) => left.session_seq - right.session_seq);
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
  currentRun: import("@ragsystem/backend-core/contracts/conversation-store/index.js").RunInfo,
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
  input: import("@ragsystem/backend-core/contracts/conversation-store/index.js").AddMessageInput & { messageId: string },
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
  existing: import("@ragsystem/backend-core/contracts/session/session.js").MessageInfo,
  input: import("@ragsystem/backend-core/contracts/conversation-store/index.js").AddMessageInput & { messageId: string },
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
  existing: import("@ragsystem/backend-core/contracts/conversation-store/index.js").RunInfo,
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
  run: import("@ragsystem/backend-core/contracts/conversation-store/index.js").RunInfo,
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
  // An independently leased background child is its own interaction recovery root
  // while retaining parent_run_id for execution-tree lineage.
}

function assertInteractionIdentity(
  existing: import("@ragsystem/backend-core/contracts/conversation-store/index.js").PendingInteractionRecord,
  input: import("@ragsystem/backend-core/contracts/conversation-store/index.js").CreatePendingInteractionInput,
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
  interaction: import("@ragsystem/backend-core/contracts/conversation-store/index.js").CreatePendingInteractionInput,
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
  record: import("@ragsystem/backend-core/contracts/conversation-store/index.js").PendingInteractionRecord,
): import("@ragsystem/backend-core/contracts/conversation-store/index.js").CreatePendingInteractionInput {
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
  record: import("@ragsystem/backend-core/contracts/conversation-store/index.js").PendingInteractionRecord,
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
  batch: readonly import("@ragsystem/backend-core/contracts/conversation-store/index.js").PendingInteractionRecord[],
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

function runBelongsToRoot(
  runId: string,
  rootRunId: string,
  activeById: ReadonlyMap<string, import("@ragsystem/backend-core/contracts/conversation-store/index.js").RunInfo>,
  independentRootIds: ReadonlySet<string> = new Set(),
): boolean {
  let current = activeById.get(runId) ?? null;
  const visited = new Set<string>();
  while (current) {
    if (current.run_id === rootRunId) return true;
    if (independentRootIds.has(current.run_id)) return false;
    if (!current.parent_run_id || visited.has(current.run_id)) return false;
    visited.add(current.run_id);
    current = activeById.get(current.parent_run_id) ?? null;
  }
  return false;
}

function maintenanceTtlMs(value: number | undefined): number {
  const ttl = value ?? 300_000;
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 3_600_000) {
    throw new Error("session maintenance ttlMs must be between 1 and 3600000 milliseconds");
  }
  return Math.trunc(ttl);
}

function activeMaintenance(
  metadata: Record<string, unknown>,
  includeExpired = false,
): { token: string; expiresAt: string } | null {
  const value = asRecord(metadata.runtime_maintenance);
  const token = typeof value.token === "string" ? value.token : "";
  const expiresAt = typeof value.expires_at === "string" ? value.expires_at : "";
  if (!token || !expiresAt) return null;
  if (!includeExpired && Date.parse(expiresAt) <= Date.now()) return null;
  return { token, expiresAt };
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
