import type { ProviderContinuationState } from "@ragsystem/agent-llm";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type { AssistantContentPart, KernelEvent } from "@ragsystem/agent-sdk";

import type { AddMessageInput, RunInfo } from "../conversation-store/index.js";
import type {
  RuntimeCommitRunInputInput,
  RuntimeCommitRunInputResult,
} from "../storage/runtime-storage.js";
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
    inputType: "user_message" | "agent_message" | "system_notification" | "goal_continuation";
    sourceKind: "user" | "agent" | "system";
    visibleToUser: boolean;
    sentAt: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown> | null;
  };
  /** Canonical input message for a newly-created root or child Run. */
  initialMessage?: AddMessageInput & { messageId: string };
  participantExpectedLastRunId?: string | null;
  initialMailboxMessageId?: string | null;
  followupPolicy?: "queue" | "reject";
  sessionMaintenanceToken?: string | null;
  initialEnvelopes?: readonly Envelope[];
}

export interface ExecutionEventPersister {
  startRun(): Promise<ExecutionStartDisposition>;
  persist(event: KernelEvent): Promise<void>;
  /** 认领插嘴后翻转 run 段归属：后续行落库与终局记录盖新 boundary。 */
  setBoundaryMessageId?(id: string | null): void;
  finalize(
    status: "completed" | "failed" | "interrupted" | "suspended",
    finalMessage: {
      id?: string;
      content: string;
      contentParts?: AssistantContentPart[];
      metadata?: Record<string, unknown>;
      /** final 轮思考全文；落库为消息行 thinking part。 */
      reasoning?: string;
      /** final 轮思考 continuation；落库为 provider_state 供跨 run 回放。 */
      providerContinuation?: import("@ragsystem/agent-llm").ChatMessage["provider_continuation"];
    } | null,
    error?: unknown,
    /** 中断/失败时当前轮 salvage（思考全文/半截正文）；terminal 消息一等保留。 */
    salvage?: {
      reasoning?: string;
      reasoningComplete?: boolean;
      content?: string;
      round?: number;
    } | null,
  ): Promise<{ readyResumeInteractionIds: string[] }>;
  resolveFinalMessage(): Promise<{ id: string; seq: number; contentParts: MessageContentPart[] } | null>;
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
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown>;
    threadKey?: string;
    childAgentId?: string | null;
  }): Promise<MessageInfo>;
  updateMessageMetadata(sessionId: string, messageId: string, metadata: Record<string, unknown>): Promise<boolean>;
  insertCompressionMessage(input: { sessionId: string; summaryContent: string; replacesUpToSeq?: number | null; threadKey?: string; childAgentId?: string | null; metadata?: Record<string, unknown> }): Promise<MessageInfo>;
}

export interface ExecutionResultReader {
  getRun(sessionId: string, runId: string): Promise<RunInfo | null>;
  listRuns(sessionId: string, limit?: number, offset?: number): Promise<{ items: RunInfo[]; total: number }>;
  getMessageById(sessionId: string, messageId: string): Promise<MessageInfo | null>;
}

export interface DurableExecutionClientEventPort {
  publish(sessionId: string, event: Envelope, options: { runId: string; aggregateType: string; aggregateId: string }): Promise<any>;
}

export interface ExecutionStorage {
  tenantId: TenantId;
  conversation: DurableExecutionConversationPort;
  agentMailbox: AgentMailboxStorePort;
  resultReader: ExecutionResultReader;
  commitRunInput(input: RuntimeCommitRunInputInput): Promise<RuntimeCommitRunInputResult>;
  createEventPersister(context: ExecutionRunPersistenceContext): ExecutionEventPersister;
}
