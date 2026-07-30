import type {
  AddMessageInput,
  AddRunStepInput,
  AppendOutboxInput,
  CreatedRun,
  CreatePendingInteractionInput,
  CreateRunInput,
  OutboxRow,
  PendingInteractionRecord,
  PendingInteractionStatus,
  ProviderContinuationRecord,
  PutProviderContinuationInput,
  RunInfo,
  RunStepRecord,
} from "../conversation-store/index.js";
import type { PermissionMode } from "../runtime/permissions.js";
import type { MessageInfo, SessionIdentity, SessionInfo } from "../session/session.js";
import type { TenantId } from "../../identity/types.js";

/** @deprecated Import CreateRunInput from conversation-store directly. */
export type RuntimeCreateRunInput = CreateRunInput;
/** @deprecated Import CreatedRun from conversation-store directly. */
export type RuntimeCreatedRun = CreatedRun;

/** Tenant-bound conversation operations used by the shared execution core. */
export interface RuntimeConversationStorage {
  createSession(input: SessionIdentity): Promise<void>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(
    sessionId: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null>;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean>;
  addMessage(input: AddMessageInput): Promise<MessageInfo>;
  getMessageById(sessionId: string, messageId: string): Promise<MessageInfo | null>;
  getRecentMessages(
    sessionId: string,
    limit?: number,
    threadKey?: string | null,
  ): Promise<MessageInfo[]>;
  insertCompressionMessage(input: {
    sessionId: string;
    summaryContent: string;
    replacesUpToSeq?: number | null;
    threadKey?: string;
    childAgentId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<MessageInfo>;
}

/** Tenant-bound run and execution-step operations. */
export interface RuntimeRunStorage {
  createRun(input: CreateRunInput): Promise<CreatedRun>;
  updateRunStatus(
    runId: string,
    sessionId: string,
    status: string,
    finalMessageId?: string | null,
  ): Promise<boolean>;
  getRun(sessionId: string, runId: string): Promise<RunInfo | null>;
  addRunStep(input: AddRunStepInput): Promise<RunStepRecord>;
  updateRunStepsMessageId(
    sessionId: string,
    runId: string,
    messageId: string,
  ): Promise<number>;
}

/** Outbox mutations used while recording execution events. */
export interface RuntimeOutboxStorage {
  appendOutbox(input: AppendOutboxInput): Promise<OutboxRow>;
  listOutboxForReplay(input: {
    sessionId: string;
    runIds?: readonly string[] | null;
    afterSeq?: number;
    limit?: number;
  }): Promise<OutboxRow[]>;
}

export interface RuntimePendingInteractionStorage {
  createPendingInteraction(input: CreatePendingInteractionInput): Promise<PendingInteractionRecord>;
  getPendingInteraction(
    sessionId: string,
    interactionId: string,
  ): Promise<PendingInteractionRecord | null>;
  listPendingInteractions(input: {
    sessionId: string;
    rootRunId?: string | null;
    batchId?: string | null;
    statuses?: PendingInteractionStatus[];
  }): Promise<PendingInteractionRecord[]>;
  updatePendingInteractionStatus(input: {
    sessionId: string;
    interactionId: string;
    from?: PendingInteractionStatus[];
    status: PendingInteractionStatus;
    resolution?: Record<string, unknown> | null;
  }): Promise<boolean>;
  markPendingBatchResuming(sessionId: string, batchId: string): Promise<number>;
  releasePendingBatch(sessionId: string, batchId: string): Promise<number>;
  finalizePendingInteractions(
    sessionId: string,
    rootRunId: string,
    status: RuntimeFinalizeStatus,
  ): Promise<string[]>;
  suspendPendingInteractions(sessionId: string, rootRunId: string): Promise<number>;
  consumePendingResolution(
    sessionId: string,
    toolCallId: string,
  ): Promise<PendingInteractionRecord | null>;
  cancelPendingInteractions(sessionId: string): Promise<number>;
}

export interface RuntimeProviderContinuationStorage {
  putProviderContinuation(input: PutProviderContinuationInput): Promise<ProviderContinuationRecord>;
  getProviderContinuation(
    sessionId: string,
    messageId: string,
  ): Promise<ProviderContinuationRecord | null>;
  deleteProviderContinuations(sessionId: string, threadKey: string): Promise<number>;
}

/** Adapter-internal repository bundle used to implement the fixed atomic operations. */
export interface RuntimeStorageRepositories {
  conversation: RuntimeConversationStorage;
  runs: RuntimeRunStorage;
  outbox: RuntimeOutboxStorage;
  pendingInteractions: RuntimePendingInteractionStorage;
  providerContinuations: RuntimeProviderContinuationStorage;
}

export interface RuntimeStartRunInput {
  session: SessionIdentity;
  run: CreateRunInput;
  /** Existing root lease required when creating or resuming a child run. */
  leaseRootRunId?: string | null;
  /** Existing durable follow-up message claimed atomically when starting a continuation root. */
  pendingUserMessageId?: string | null;
  /** Allows the maintenance owner to atomically replace its reservation with a new root run. */
  sessionMaintenanceToken?: string | null;
  initialUserMessage?: AddMessageInput & { messageId: string };
  /** Initial client envelopes committed atomically with the run and first user message. */
  initialRecords?: readonly RuntimeRecordEnvelopeInput[];
}

export interface RuntimeStartRunResult {
  run: CreatedRun;
  initialUserMessage: MessageInfo | null;
  records: RuntimeRecordEnvelopeResult[];
}

export interface RuntimeRootFollowupFactoryResult {
  message: AddMessageInput & { messageId: string };
  recordFactory(message: MessageInfo): readonly RuntimeRecordEnvelopeInput[];
}

/** Pure synchronous factory invoked under the session transaction fence. */
export type RuntimeRootFollowupFactory = (input: { activeRunId: string; roundIndex: number }) => RuntimeRootFollowupFactoryResult;

export interface RuntimeStartOrAppendRootInput extends RuntimeStartRunInput {
  /**
   * When set, an active root run is reported without writing a user message.
   * The execution service queues the message and persists it at the next round boundary.
   */
  deferFollowup?: boolean;
  followupFactory: RuntimeRootFollowupFactory;
  /** Builds the durable terminal event when this distributed start fences an expired prior root. */
  buildExpiredRunEndedRecord?: (run: {
    sessionId: string;
    runId: string;
    parentRunId: null;
    status: "interrupted" | "suspended";
    reason: "run_lease_expired" | "backend_restarted_waiting_interaction";
  }) => RuntimeRecordEnvelopeInput;
}

export type RuntimeStartOrAppendRootResult =
  | ({ kind: "started" } & RuntimeStartRunResult)
  | {
      kind: "followup";
      activeRunId: string;
      /** False when the active root is leased by another distributed instance. */
      ownedByCurrentInstance?: boolean;
      /** Present for legacy callers that persist follow-ups inside the transaction. */
      message?: MessageInfo;
      /** Present for legacy callers that persist follow-ups inside the transaction. */
      records?: RuntimeRecordEnvelopeResult[];
    };

export interface RuntimeRecordEnvelopeInput {
  step?: AddRunStepInput | null;
  outbox: AppendOutboxInput & { eventId: string };
  /** Distributed execution write fence; storage resolves the run root and verifies ownership. */
  requireRunLease?: boolean;
}

export interface RuntimeRecordEnvelopeResult {
  step: RunStepRecord | null;
  outbox: OutboxRow;
}

export type RuntimeFinalizeStatus = "completed" | "failed" | "interrupted" | "suspended";

export interface RuntimeFinalizeRunInput {
  runId: string;
  sessionId: string;
  status: RuntimeFinalizeStatus;
  /** Root lease that must still belong to this storage instance in the finalization transaction. */
  leaseRootRunId?: string | null;
  finalMessage?: (AddMessageInput & { messageId: string }) | null;
  attachStepsToFinalMessage?: boolean;
  /** Present only when finalizing the root run; applies the root interaction status matrix atomically. */
  interactionRootRunId?: string | null;
  deleteProviderContinuationThreadKey?: string | null;
  closeDanglingToolCalls?: {
    threadKey: string;
    agentName: string;
  } | null;
  /**
   * Builds terminal step/outbox records after final and interrupted-tool messages have been inserted.
   * This callback runs inside the database transaction and must be synchronous and free of I/O.
   */
  buildTerminalRecords?: (
    finalMessage: MessageInfo | null,
    closedToolMessages?: readonly MessageInfo[],
  ) => readonly RuntimeRecordEnvelopeInput[];
}

export interface RuntimeFinalizeRunResult {
  finalMessage: MessageInfo | null;
  records: RuntimeRecordEnvelopeResult[];
  readyResumeInteractionIds: string[];
}

export interface RuntimePersistMessageInput {
  message: AddMessageInput & { messageId: string };
  /** Root lease that must still belong to this storage instance in the message transaction. */
  leaseRootRunId?: string | null;
  deleteProviderContinuationThreadKey?: string | null;
  providerContinuation?: PutProviderContinuationInput | null;
}

export interface RuntimePersistMessageResult {
  message: MessageInfo;
  deletedProviderContinuations: number;
  providerContinuation: ProviderContinuationRecord | null;
}

export type RuntimeInteractionResolution =
  | { kind: "approval"; approved: boolean; message: string }
  | { kind: "user_input"; value: string };

export type RuntimeInteractionUnavailableReason = "not_found" | "kind_mismatch" | "cancelled";

/** Expected response-time rejection; transports should present it as a missing interaction. */
export class RuntimeInteractionUnavailableError extends Error {
  override readonly name = "RuntimeInteractionUnavailableError";

  constructor(
    readonly reason: RuntimeInteractionUnavailableReason,
    interactionId: string,
  ) {
    super(`pending interaction ${reason}: ${interactionId}`);
  }
}

export interface RuntimeRecordInteractionInput {
  interaction: CreatePendingInteractionInput;
  rootCallId: string;
  record: RuntimeRecordEnvelopeInput;
}

export interface RuntimeRecordInteractionResult {
  interaction: PendingInteractionRecord;
  record: RuntimeRecordEnvelopeResult;
}

export interface RuntimeResolveInteractionInput {
  sessionId: string;
  interactionId: string;
  resolution: RuntimeInteractionResolution;
  /** Built after loading the durable interaction, so callers do not need its run scope after restart. */
  buildRecord(interaction: PendingInteractionRecord): RuntimeRecordEnvelopeInput;
}

export interface RuntimeResolveInteractionResult {
  interaction: PendingInteractionRecord;
  previousStatus: PendingInteractionStatus;
  changed: boolean;
  batchReady: boolean;
  rootRunStatus: string;
  record: RuntimeRecordEnvelopeResult;
}

export interface RuntimeClaimResumeInput {
  sessionId: string;
  interactionId: string;
  claimId: string;
  leaseMs?: number;
}

export interface RuntimeAttachResumeInput {
  sessionId: string;
  rootRunId: string;
  claimId: string;
  batchId: string;
  record: RuntimeRecordEnvelopeInput;
}
export interface RuntimeAttachResumeResult {
  attached: boolean;
  record: RuntimeRecordEnvelopeResult | null;
}
export interface RuntimeRecoverExpiredResumeClaimsInput {
  sessionId: string;
  /** Optional clock override used by deterministic maintenance tests. */
  now?: string;
}
export interface RuntimeRecoverExpiredResumeClaimsResult {
  recoveredClaimIds: string[];
  recoveredBatchIds: string[];
  suspendedRootRunIds: string[];
}

export type RuntimeClaimResumeResult =
  | {
      claimed: false;
      reason: "not_found" | "batch_incomplete" | "root_not_suspended" | "already_claimed" | "terminal";
    }
  | {
      claimed: true;
      claimId: string;
      batchId: string;
      rootRunId: string;
      rootCallId: string;
      agentName: string;
      task: string;
      requestId: string | null;
      executionKind: string;
      userId: string | null;
      sessionIdentity: SessionIdentity;
      resolutions: Array<{
        interactionId: string;
        toolCallId: string;
        resolution: RuntimeInteractionResolution;
      }>;
    };

export interface RuntimeRollbackResumeInput {
  sessionId: string;
  rootRunId: string;
  claimId: string;
  /** Allows the immediate post-attach start failure to restore running+resolved back to suspended. */
  batchId?: string;
}

export interface RuntimeRollbackResumeResult {
  rolledBack: boolean;
}

export interface RuntimeInterruptSessionInput {
  sessionId: string;
  buildRunEndedRecord(run: { runId: string; parentRunId: string | null }): RuntimeRecordEnvelopeInput;
}

export interface RuntimeInterruptSessionResult {
  interruptedRuns: Array<{ runId: string; parentRunId: string | null }>;
  cancelledInteractions: number;
  records: RuntimeRecordEnvelopeResult[];
}

export interface RuntimeRenewRunLeaseInput {
  sessionId: string;
  rootRunId: string;
  leaseMs?: number;
}

export interface RuntimeRenewRunLeaseResult {
  renewed: boolean;
  expiresAt: string | null;
}

export interface RuntimeRecoverExpiredRunLeasesInput {
  /** Optional clock override used by deterministic maintenance tests. */
  now?: string;
  buildRunEndedRecord(run: {
    sessionId: string;
    runId: string;
    parentRunId: null;
    status: "interrupted" | "suspended";
    reason: "run_lease_expired" | "backend_restarted_waiting_interaction";
  }): RuntimeRecordEnvelopeInput;
}

export interface RuntimeRecoverExpiredRunLeasesResult {
  interruptedRuns: Array<{ sessionId: string; runId: string; parentRunId: string | null }>;
  suspendedRuns: Array<{ sessionId: string; runId: string; parentRunId: string | null }>;
  cancelledInteractions: number;
  records: RuntimeRecordEnvelopeResult[];
}

export interface RuntimeGetActiveRootRunResult {
  runId: string | null;
}

export interface RuntimeSessionFacts {
  session: SessionInfo | null;
  activeRootRun: RunInfo | null;
  latestTerminalRootRun: RunInfo | null;
  pendingInteractions: PendingInteractionRecord[];
  ownedByCurrentInstance: boolean;
}

export interface RuntimeConsumePendingFollowupsInput {
  sessionId: string;
  rootRunId: string;
  messageIds: readonly string[];
}

export interface RuntimeConsumePendingFollowupsResult {
  messages: MessageInfo[];
}

export interface RuntimeSessionMaintenanceInput {
  sessionId: string;
  token: string;
  kind: "rollback" | "compact";
  ttlMs?: number;
}

export interface RuntimeClaimSessionMaintenanceResult {
  claimed: boolean;
  activeRunId: string | null;
}

export interface RuntimeAtomicOperations {
  startRun(input: RuntimeStartRunInput): Promise<RuntimeStartRunResult>;
  startOrAppendRoot(input: RuntimeStartOrAppendRootInput): Promise<RuntimeStartOrAppendRootResult>;
  persistMessage(input: RuntimePersistMessageInput): Promise<RuntimePersistMessageResult>;
  /** `outbox.eventId` is the shared idempotency key for the outbox row and optional run step. */
  recordEnvelope(input: RuntimeRecordEnvelopeInput): Promise<RuntimeRecordEnvelopeResult>;
  recordInteraction(input: RuntimeRecordInteractionInput): Promise<RuntimeRecordInteractionResult>;
  resolveInteraction(input: RuntimeResolveInteractionInput): Promise<RuntimeResolveInteractionResult>;
  claimResume(input: RuntimeClaimResumeInput): Promise<RuntimeClaimResumeResult>;
  /** Executor is registered; release the short election claim while keeping the resolution retryable. */
  attachResume(input: RuntimeAttachResumeInput): Promise<RuntimeAttachResumeResult>;
  rollbackResume(input: RuntimeRollbackResumeInput): Promise<RuntimeRollbackResumeResult>;
  interruptSession(input: RuntimeInterruptSessionInput): Promise<RuntimeInterruptSessionResult>;
  recoverExpiredResumeClaims(input: RuntimeRecoverExpiredResumeClaimsInput): Promise<RuntimeRecoverExpiredResumeClaimsResult>;
  /** Present on distributed stores that fence live root executions with an owner lease. */
  renewRunLease?(input: RuntimeRenewRunLeaseInput): Promise<RuntimeRenewRunLeaseResult>;
  /** Present on distributed stores; only expired (or legacy unleased) roots may be recovered. */
  recoverExpiredRunLeases?(input: RuntimeRecoverExpiredRunLeasesInput): Promise<RuntimeRecoverExpiredRunLeasesResult>;
  /** Durable session-level activity check used before destructive maintenance commands. */
  getActiveRootRun?(sessionId: string): Promise<RuntimeGetActiveRootRunResult>;
  /** One authoritative read model for Session lifecycle projection and initial loading. */
  getSessionRuntimeFacts(sessionId: string): Promise<RuntimeSessionFacts>;
  /** Claims durable follow-ups at a safe round boundary under the root lease fence. */
  consumePendingFollowups(input: RuntimeConsumePendingFollowupsInput): Promise<RuntimeConsumePendingFollowupsResult>;
  claimSessionMaintenance(input: RuntimeSessionMaintenanceInput): Promise<RuntimeClaimSessionMaintenanceResult>;
  renewSessionMaintenance(input: Pick<RuntimeSessionMaintenanceInput, "sessionId" | "token" | "ttlMs">): Promise<boolean>;
  releaseSessionMaintenance(input: Pick<RuntimeSessionMaintenanceInput, "sessionId" | "token">): Promise<void>;
  finalizeRun(input: RuntimeFinalizeRunInput): Promise<RuntimeFinalizeRunResult>;
}

/**
 * Tenant-bound storage boundary. Cross-domain atomicity is exposed only through
 * fixed operations so callers cannot hold a database transaction across model or tool I/O.
 */
export interface RuntimeStorage {
  readonly tenantId: TenantId;
  readonly operations: RuntimeAtomicOperations;
}
