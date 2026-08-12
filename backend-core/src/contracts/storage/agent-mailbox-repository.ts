import type { MessageContentPart } from "@ragsystem/agent-protocol";

/** Durable message kinds exchanged by agents while an invocation is alive. */
export type AgentMailboxMessageKind =
  | "progress"
  | "request"
  | "response"
  | "result"
  | "cancel";

export type AgentMailboxInputType =
  | "user_message"
  | "agent_message"
  | "system_notification"
  | "goal_continuation";

export type AgentMailboxSourceKind = "user" | "agent" | "system";

export type AgentMailboxMessageStatus =
  | "queued"
  | "claimed"
  | "acked"
  | "expired";

export interface AgentMailboxMessage {
  seq: number;
  message_id: string;
  tenant_id: string;
  session_id: string;
  source_run_id: string | null;
  source_agent_call_id: string | null;
  target_run_id: string | null;
  target_agent_call_id: string | null;
  target_thread_key: string;
  target_child_agent_id: string | null;
  kind: AgentMailboxMessageKind;
  input_type: AgentMailboxInputType;
  source_kind: AgentMailboxSourceKind;
  visible_to_user: boolean;
  sent_at: string | null;
  correlation_id: string | null;
  reply_to_message_id: string | null;
  content_parts: MessageContentPart[];
  metadata: Record<string, unknown>;
  status: AgentMailboxMessageStatus;
  attempt_count: number;
  claim_id: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  available_at: string;
  expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  acked_at: string | null;
}

export interface EnqueueAgentMailboxMessageInput {
  messageId: string;
  tenantId: string;
  sessionId: string;
  sourceRunId?: string | null;
  sourceAgentCallId?: string | null;
  targetRunId?: string | null;
  targetAgentCallId?: string | null;
  targetThreadKey: string;
  targetChildAgentId?: string | null;
  kind: AgentMailboxMessageKind;
  inputType?: AgentMailboxInputType;
  sourceKind?: AgentMailboxSourceKind;
  visibleToUser?: boolean;
  sentAt?: string | null;
  correlationId?: string | null;
  replyToMessageId?: string | null;
  contentParts?: MessageContentPart[];
  metadata?: Record<string, unknown>;
  availableAt?: string;
  expiresAt?: string | null;
}

export interface ClaimAgentMailboxInput {
  sessionId: string;
  targetRunId?: string | null;
  targetAgentCallId?: string | null;
  targetThreadKey: string;
  targetChildAgentId?: string | null;
  claimId: string;
  consumerId: string;
  leaseMs?: number;
  limit?: number;
  now?: string;
}

export interface AckAgentMailboxInput {
  sessionId: string;
  messageId: string;
  claimId: string;
}

export interface ReleaseAgentMailboxInput {
  sessionId: string;
  messageId: string;
  claimId: string;
  availableAt?: string;
  lastError?: string | null;
}

export interface SettleAgentMailboxInput {
  sessionId: string;
  messageId: string;
}

export interface ListPendingAgentMailboxInput {
  sessionId: string;
  targetRunId?: string | null;
  targetAgentCallId?: string | null;
  targetThreadKey?: string | null;
  targetChildAgentId?: string | null;
  kinds?: readonly AgentMailboxMessageKind[];
  limit?: number;
  now?: string;
}

/** Target used to wake an idle parent after a background child publishes a result. */
export interface AgentMailboxWakeupTarget {
  sessionId: string;
  targetRunId: string;
  targetAgentCallId: string | null;
  targetThreadKey: string;
  targetChildAgentId: string | null;
  targetAgentName: string | null;
  targetRootRunId: string | null;
  targetParentRunId: string | null;
  targetParentCallId: string | null;
  targetLineageParentCallId: string | null;
  /** Mailbox request that caused this wakeup, used to correlate the automatic result. */
  sourceMessageId?: string | null;
  correlationId?: string | null;
}

/**
 * Promise-only durable mailbox port. Implementations must fence every state
 * transition with claimId so a worker whose lease expired cannot ACK a newer
 * claim. `claim` is FIFO and atomically requeues expired claims before picking
 * new messages.
 */
export interface AgentMailboxStorePort {
  enqueue(input: EnqueueAgentMailboxMessageInput): Promise<AgentMailboxMessage>;
  get(sessionId: string, messageId: string): Promise<AgentMailboxMessage | null>;
  /** Read queued messages for restart/idle wakeup orchestration. */
  listPending?(input: ListPendingAgentMailboxInput): Promise<AgentMailboxMessage[]>;
  claim(input: ClaimAgentMailboxInput): Promise<AgentMailboxMessage[]>;
  ack(input: AckAgentMailboxInput): Promise<boolean>;
  /** Terminal recovery only: prevent a durably finalized continuation source from being retried. */
  settle(input: SettleAgentMailboxInput): Promise<boolean>;
  release(input: ReleaseAgentMailboxInput): Promise<boolean>;
  expire(input?: { sessionId?: string; now?: string }): Promise<number>;
}
