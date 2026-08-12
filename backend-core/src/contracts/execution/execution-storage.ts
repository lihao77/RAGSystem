import type { ProviderContinuationState } from "@ragsystem/agent-llm";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type { AssistantContentPart, KernelEvent } from "@ragsystem/agent-sdk";

import type { RunInfo } from "../conversation-store/index.js";
import type { RunStepInfo } from "../common.js";
import type { Envelope } from "../events.js";
import type { MessageInfo, SessionIdentity, SessionInfo } from "../session/session.js";
import type { TenantId } from "../../identity/types.js";
import type { AgentMailboxStorePort } from "../storage/agent-mailbox-repository.js";

export type ExecutionStartDisposition =
  | { kind: "started" }
  | {
      kind: "followup";
      activeRunId: string;
      queueAccepted: boolean;
      messageId: string | null;
    };

export interface ExecutionRunPersistenceContext {
  tenantId: TenantId;
  sessionId: string;
  runId: string;
  threadKey: string;
  agentName: string;
  agentDisplayName: string;
  rootCallId: string;
  rootRunId?: string;
  taskId?: string | null;
  providerType?: string;
  executionKind?: string;
  taskSummary?: string;
  requestId?: string | null;
  userId?: string | null;
  sessionIdentity: SessionIdentity;
  parentRunId?: string | null;
  parentCallId?: string | null;
  childAgentId?: string | null;
  /** Propagated cancellation signal; used only to preserve child terminal projection on parent abort. */
  signal?: AbortSignal;
  messageMetadata?: Record<string, unknown> | null;
  rootMailboxMessage?: {
    id: string;
    inputType: "user_message" | "system_notification" | "goal_continuation";
    sourceKind: "user" | "system";
    visibleToUser: boolean;
    sentAt: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown> | null;
  };
  followupPolicy?: "queue" | "reject";
  sessionMaintenanceToken?: string | null;
  initialEnvelopes?: readonly Envelope[];
}

export interface ExecutionEventPersister {
  startRun(): Promise<ExecutionStartDisposition>;
  persist(event: KernelEvent): Promise<void>;
  finalize(status: "completed" | "failed" | "interrupted" | "suspended", finalMessage: { id?: string; content: string; contentParts?: AssistantContentPart[]; metadata?: Record<string, unknown> } | null, error?: unknown): Promise<{ readyResumeInteractionIds: string[] }>;
  resolveFinalMessage(): Promise<{ id: string; seq: number; content: string } | null>;
}

export interface DurableExecutionConversationPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  getMessageById(sessionId: string, messageId: string): Promise<MessageInfo | null>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  addMessage(input: {
    sessionId: string;
    messageId?: string;
    role: MessageInfo["role"];
    content: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown>;
    threadKey?: string;
    childAgentId?: string | null;
  }): Promise<MessageInfo>;
  updateMessageMetadata(sessionId: string, messageId: string, metadata: Record<string, unknown>): Promise<boolean>;
  insertCompressionMessage(input: { sessionId: string; summaryContent: string; replacesUpToSeq?: number | null; threadKey?: string; childAgentId?: string | null; metadata?: Record<string, unknown> }): Promise<MessageInfo>;
}

export interface DurableExecutionProviderContinuationPort {
  getProviderContinuation(tenantId: TenantId, sessionId: string, messageId: string): Promise<{ state: ProviderContinuationState } | null>;
}

export interface ExecutionProviderContinuationPort {
  getProviderContinuation(sessionId: string, messageId: string): Promise<{ state: ProviderContinuationState } | null>;
}

export interface ExecutionRunStepQuery {
  runId?: string | null;
  messageId?: string | null;
  sessionId?: string | null;
  limit?: number;
}

export interface ExecutionResultReader {
  getRun(sessionId: string, runId: string): Promise<RunInfo | null>;
  listRuns(sessionId: string, limit?: number, offset?: number): Promise<{ items: RunInfo[]; total: number }>;
  getMessageById(sessionId: string, messageId: string): Promise<MessageInfo | null>;
  listRunSteps(input: ExecutionRunStepQuery): Promise<RunStepInfo[]>;
}

export interface DurableExecutionClientEventPort {
  publish(sessionId: string, event: Envelope, options: { runId: string; aggregateType: string; aggregateId: string }): Promise<any>;
}

export interface ExecutionStorage {
  tenantId: TenantId;
  conversation: DurableExecutionConversationPort;
  agentMailbox: AgentMailboxStorePort;
  providerContinuations: ExecutionProviderContinuationPort;
  resultReader: ExecutionResultReader;
  createEventPersister(context: ExecutionRunPersistenceContext): ExecutionEventPersister;
}
