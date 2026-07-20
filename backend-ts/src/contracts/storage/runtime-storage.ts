import type {
  AddMessageInput,
  AddRunStepInput,
  AppendOutboxInput,
  CreatePendingInteractionInput,
  OutboxRow,
  PendingInteractionRecord,
  PendingInteractionStatus,
  ProviderContinuationRecord,
  PutProviderContinuationInput,
  RunInfo,
  RunStepRecord,
} from "../conversation-store/index.js";
import type { PermissionMode } from "../runtime/permissions.js";
import type { MessageInfo, SessionInfo } from "../session/session.js";
import type { TenantId } from "../../identity/types.js";

export type RuntimeCreateRunInput = Parameters<
  import("../conversation-store/index.js").IRunStore["createRun"]
>[0];

export type RuntimeCreatedRun = ReturnType<
  import("../conversation-store/index.js").IRunStore["createRun"]
>;

/** Tenant-bound conversation operations used by the shared execution core. */
export interface RuntimeConversationStorage {
  createSession(
    sessionId: string,
    userId: string | null,
    metadata?: Record<string, unknown>,
    permissionMode?: PermissionMode | null,
  ): Promise<void>;
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
  createRun(input: RuntimeCreateRunInput): Promise<RuntimeCreatedRun>;
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
  session: {
    sessionId: string;
    userId: string | null;
    metadata?: Record<string, unknown>;
    permissionMode?: PermissionMode | null;
  };
  run: RuntimeCreateRunInput;
  initialUserMessage?: AddMessageInput & { messageId: string };
}

export interface RuntimeStartRunResult {
  run: RuntimeCreatedRun;
  initialUserMessage: MessageInfo | null;
}

export interface RuntimeRecordEnvelopeInput {
  step?: AddRunStepInput | null;
  outbox: AppendOutboxInput & { eventId: string };
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
   * Builds terminal step/outbox records after the final message has been inserted.
   * This callback runs inside the database transaction and must be synchronous and free of I/O.
   */
  buildTerminalRecords?: (
    finalMessage: MessageInfo | null,
  ) => readonly RuntimeRecordEnvelopeInput[];
}

export interface RuntimeFinalizeRunResult {
  finalMessage: MessageInfo | null;
  records: RuntimeRecordEnvelopeResult[];
  readyResumeInteractionIds: string[];
}

export interface RuntimePersistMessageInput {
  message: AddMessageInput & { messageId: string };
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

export interface RuntimeRenewResumeClaimInput { sessionId: string; rootRunId: string; claimId: string; leaseMs?: number }
export interface RuntimeRenewResumeClaimResult { renewed: boolean; expiresAt: string | null }
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
      sessionMetadata: Record<string, unknown>;
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

export interface RuntimeAtomicOperations {
  startRun(input: RuntimeStartRunInput): Promise<RuntimeStartRunResult>;
  persistMessage(input: RuntimePersistMessageInput): Promise<RuntimePersistMessageResult>;
  /** `outbox.eventId` is the shared idempotency key for the outbox row and optional run step. */
  recordEnvelope(input: RuntimeRecordEnvelopeInput): Promise<RuntimeRecordEnvelopeResult>;
  recordInteraction(input: RuntimeRecordInteractionInput): Promise<RuntimeRecordInteractionResult>;
  resolveInteraction(input: RuntimeResolveInteractionInput): Promise<RuntimeResolveInteractionResult>;
  claimResume(input: RuntimeClaimResumeInput): Promise<RuntimeClaimResumeResult>;
  renewResumeClaim(input: RuntimeRenewResumeClaimInput): Promise<RuntimeRenewResumeClaimResult>;
  rollbackResume(input: RuntimeRollbackResumeInput): Promise<RuntimeRollbackResumeResult>;
  interruptSession(input: RuntimeInterruptSessionInput): Promise<RuntimeInterruptSessionResult>;
  recoverExpiredResumeClaims(input: RuntimeRecoverExpiredResumeClaimsInput): Promise<RuntimeRecoverExpiredResumeClaimsResult>;
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
