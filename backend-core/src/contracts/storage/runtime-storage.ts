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
  UpdateChildAgentLastRunInput,
} from "../conversation-store/index.js";
import type { PermissionMode } from "../runtime/permissions.js";
import type { MessageInfo, SessionIdentity, SessionInfo } from "../session/session.js";
import type { TenantId } from "../../identity/types.js";
import type {
  AgentMailboxMessage,
  AgentMailboxStorePort,
  AckAgentMailboxInput,
  EnqueueAgentMailboxMessageInput,
} from "./agent-mailbox-repository.js";

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
    terminalReason?: string | null,
  ): Promise<boolean>;
  getRun(sessionId: string, runId: string): Promise<RunInfo | null>;
  ensureInitialRunMessageBoundary(sessionId: string, runId: string, messageId: string): Promise<void>;
  addRunStep(input: AddRunStepInput): Promise<RunStepRecord>;
}

/** Outbox mutations used while recording execution events. */
export interface RuntimeOutboxStorage {
  appendOutbox(input: AppendOutboxInput): Promise<OutboxRow>;
  listOutboxForReplay(input: {
    sessionId: string;
    runIds?: readonly string[] | null;
    afterSeq?: number;
    limit?: number;
    /** Return the newest matching page, still ordered by ascending session sequence. */
    latest?: boolean;
    eventTypes?: readonly string[] | null;
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

export interface RuntimeParticipantStorage {
  updateChildAgentLastRun(input: UpdateChildAgentLastRunInput): Promise<boolean>;
}

/** Adapter-internal repository bundle used to implement the fixed atomic operations. */
export interface RuntimeStorageRepositories {
  conversation: RuntimeConversationStorage;
  runs: RuntimeRunStorage;
  outbox: RuntimeOutboxStorage;
  pendingInteractions: RuntimePendingInteractionStorage;
  providerContinuations: RuntimeProviderContinuationStorage;
  agentMailbox: AgentMailboxStorePort;
  participants: RuntimeParticipantStorage;
}

export interface RuntimeStartRunInput {
  session: SessionIdentity;
  run: CreateRunInput;
  /**
   * Canonical input message that owns the Run's first execution segment.
   * Storage requires this when creating a Run and omits it only when resuming
   * an already-persisted Run.
   */
  initialMessage?: AddMessageInput & { messageId: string };
  /** Atomically advances the child participant's durable latest-Run pointer. */
  participantRun?: {
    childAgentId: string;
    expectedLastRunId: string | null;
  };
  /** Queued mailbox seed settled in the same transaction as a newly-created Run. */
  initialMailboxMessageId?: string | null;
  /** Existing root lease required when creating or resuming a child run. */
  leaseRootRunId?: string | null;
  /** This non-root run owns an independent lease instead of inheriting its execution-tree root lease. */
  claimOwnLease?: boolean;
  /** Allows the maintenance owner to atomically replace its reservation with a new root run. */
  sessionMaintenanceToken?: string | null;
  /** Initial client envelopes committed atomically with the run. */
  initialRecords?: readonly RuntimeRecordEnvelopeInput[];
}

export interface RuntimeStartRunResult {
  run: CreatedRun;
  records: RuntimeRecordEnvelopeResult[];
}

export interface RuntimeStartOrAppendRootInput extends Omit<RuntimeStartRunInput, "initialMessage"> {
  mailboxMessage: EnqueueAgentMailboxMessageInput;
  followupPolicy: "queue" | "reject";
}

/** Derive the canonical root conversation message from its single durable mailbox input. */
export function rootMailboxInitialMessage(
  input: RuntimeStartOrAppendRootInput,
): AddMessageInput & { messageId: string } {
  return rootMailboxConversationMessage({
    sessionId: input.session.sessionId,
    runId: input.run.runId,
    mailboxMessage: input.mailboxMessage,
  });
}

export function rootMailboxConversationMessage(input: {
  sessionId: string;
  runId: string;
  mailboxMessage: EnqueueAgentMailboxMessageInput;
}): AddMessageInput & { messageId: string } {
  const message = input.mailboxMessage;
  const displayContent = (message.contentParts ?? []).flatMap((part) => {
    if (part.type === "text") return [part.text];
    if (part.type === "command_ref") return [part.raw_text];
    return [];
  }).join("\n").trim();
  const content = message.inputType === "agent_message"
    ? `[agent-message kind=${message.kind} id=${message.messageId}]\n${displayContent}\n[/agent-message]`
    : displayContent;
  return {
    sessionId: input.sessionId,
    messageId: message.messageId,
    role: "user",
    content,
    contentParts: message.inputType === "agent_message"
      ? [{ type: "text", text: content }]
      : message.contentParts ?? [],
    metadata: {
      ...(message.metadata ?? {}),
      ...(message.inputType === "agent_message" ? { agent_message: true } : {}),
      mailbox_message_id: message.messageId,
      run_id: input.runId,
      consumed_by_run_id: input.runId,
    },
    threadKey: "root",
    childAgentId: null,
  };
}

export type RuntimeStartOrAppendRootResult =
  | ({ kind: "started"; mailboxMessage: AgentMailboxMessage } & RuntimeStartRunResult)
  | {
      kind: "followup";
      activeRunId: string;
      /** False when the active root is leased by another distributed instance. */
      ownedByCurrentInstance?: boolean;
      mailboxMessage: AgentMailboxMessage | null;
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

/**
 * Attach the canonical conversation sequence to an envelope committed in the
 * same transaction as the message. The mailbox sequence and outbox sequence
 * describe different journals and must never be used to order chat messages.
 */
export function withCanonicalMessageSequence(
  record: RuntimeRecordEnvelopeInput,
  message: Pick<MessageInfo, "id" | "seq">,
): RuntimeRecordEnvelopeInput {
  const attach = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const envelope = value as Record<string, unknown>;
    const payload = envelope.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return value;
    const payloadRecord = payload as Record<string, unknown>;
    if (envelope.type === "agent_message"
      && (envelope.message_id === message.id || payloadRecord.message_id === message.id)) {
      return { ...envelope, payload: { ...payloadRecord, seq: message.seq } };
    }
    const ref = payloadRecord.ref;
    if (envelope.type === "state_sync"
      && payloadRecord.category === "message_saved"
      && ref && typeof ref === "object" && !Array.isArray(ref)
      && (ref as Record<string, unknown>).message_id === message.id) {
      return {
        ...envelope,
        payload: {
          ...payloadRecord,
          ref: { ...(ref as Record<string, unknown>), seq: message.seq },
        },
      };
    }
    return value;
  };
  const outboxPayload = record.outbox.payload;
  const clientEvent = outboxPayload && typeof outboxPayload === "object" && !Array.isArray(outboxPayload)
    ? (outboxPayload as Record<string, unknown>).client_event
    : null;
  const nextClientEvent = attach(clientEvent);
  const nextStepPayload = record.step ? attach(record.step.payload) : null;
  if (nextClientEvent === clientEvent && (!record.step || nextStepPayload === record.step.payload)) return record;
  return {
    ...record,
    ...(record.step ? { step: { ...record.step, payload: nextStepPayload as Record<string, unknown> } } : {}),
    outbox: {
      ...record.outbox,
      payload: {
        ...(outboxPayload as Record<string, unknown>),
        client_event: nextClientEvent,
      },
    },
  };
}

/** One durable input boundary consumed by an already-running Run. */
export interface RuntimeCommitRunInputInput {
  runId: string;
  sessionId: string;
  message: AddMessageInput & { messageId: string };
  record: RuntimeRecordEnvelopeInput;
  mailboxAck: AckAgentMailboxInput;
  leaseRootRunId?: string | null;
}

export interface RuntimeCommitRunInputResult {
  message: MessageInfo;
  record: RuntimeRecordEnvelopeResult;
  mailboxAcked: boolean;
}

export type RuntimeFinalizeStatus = "completed" | "failed" | "interrupted" | "suspended";

export interface RuntimeFinalizeRunInput {
  runId: string;
  sessionId: string;
  status: RuntimeFinalizeStatus;
  /** Normalized terminal reason persisted with failed/interrupted runs. */
  reason?: string | null;
  /** Root lease that must still belong to this storage instance in the finalization transaction. */
  leaseRootRunId?: string | null;
  finalMessage?: (AddMessageInput & { messageId: string }) | null;
  /** Present only when finalizing the root run; applies the root interaction status matrix atomically. */
  interactionRootRunId?: string | null;
  closeDanglingToolCalls?: {
    threadKey: string;
    childAgentId?: string | null;
    agentName: string;
    terminalStatus: "failed" | "interrupted";
    reason: string;
  } | null;
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
      threadKey: string;
      parentRunId: string | null;
      parentCallId: string | null;
      lineageParentCallId: string | null;
      childAgentId: string | null;
      workspaceRoot: string | null;
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
  /** Ordered durable client envelopes for the active root run and all descendants. */
  activeRunEvents: OutboxRow[];
  ownedByCurrentInstance: boolean;
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
  /** Canonical message, Run-Step boundary, outbox, and mailbox ACK commit together. */
  commitRunInput(input: RuntimeCommitRunInputInput): Promise<RuntimeCommitRunInputResult>;
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
