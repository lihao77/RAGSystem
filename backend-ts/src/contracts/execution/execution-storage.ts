import type { ProviderContinuationState } from "@ragsystem/agent-llm";
import type { KernelEvent } from "@ragsystem/agent-sdk";

import type { ConversationStore } from "../conversation-store/index.js";
import type { Envelope } from "../events.js";
import type { MessageInfo, SessionInfo } from "../session/session.js";
import type { TenantId } from "../../identity/types.js";
type Awaitable<T> = T | Promise<T>;
export type ExecutionStartDisposition =
  | { kind: "started" }
  | { kind: "followup"; activeRunId: string; messageId: string };

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
  parentRunId?: string | null;
  parentCallId?: string | null;
  childAgentId?: string | null;
  messageMetadata?: Record<string, unknown> | null;
  initialUserMessage?: { id: string; content: string; metadata?: Record<string, unknown> | null };
  initialEnvelopes?: readonly Envelope[];
}

export interface ExecutionEventPersister {
  startRun(): ExecutionStartDisposition | Promise<ExecutionStartDisposition>;
  persist(event: KernelEvent): void | Promise<void>;
  finalize(status: "completed" | "failed" | "interrupted" | "suspended", finalMessage: { id?: string; content: string; metadata?: Record<string, unknown> } | null, error?: unknown): { readyResumeInteractionIds: string[] } | Promise<{ readyResumeInteractionIds: string[] }>;
  resolveFinalMessage(): { id: string; seq: number; content: string } | null | Promise<{ id: string; seq: number; content: string } | null>;
}

export interface DurableExecutionConversationPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Awaitable<MessageInfo[]>;
  getSession(sessionId: string): Awaitable<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Awaitable<Record<string, unknown> | null>;
  addMessage(input: {
    sessionId: string;
    role: MessageInfo["role"];
    content: string;
    metadata?: Record<string, unknown>;
    threadKey?: string;
    childAgentId?: string | null;
  }): Awaitable<MessageInfo>;
  insertCompressionMessage(input: { sessionId: string; summaryContent: string; replacesUpToSeq?: number | null; threadKey?: string; childAgentId?: string | null; metadata?: Record<string, unknown> }): Awaitable<MessageInfo>;
}

export interface DurableExecutionProviderContinuationPort {
  getProviderContinuation(tenantId: TenantId, sessionId: string, messageId: string): Promise<{ state: ProviderContinuationState } | null>;
}

export interface ExecutionProviderContinuationPort {
  getProviderContinuation(sessionId: string, messageId: string): Awaitable<{ state: ProviderContinuationState } | null>;
}

export interface ExecutionMemoryCandidatePort {
  listMemoryCandidates(query: Parameters<ConversationStore["listMemoryCandidates"]>[0]): Awaitable<ReturnType<ConversationStore["listMemoryCandidates"]>>;
}

export interface ExecutionResultReader {
  getRun(sessionId: string, runId: string): Awaitable<ReturnType<ConversationStore["getRun"]>>;
  getMessageById(sessionId: string, messageId: string): Awaitable<ReturnType<ConversationStore["getMessageById"]>>;
  listRunSteps(input: Parameters<ConversationStore["listRunSteps"]>[0]): Awaitable<ReturnType<ConversationStore["listRunSteps"]>>;
}

export interface DurableExecutionClientEventPort {
  publish(sessionId: string, event: Envelope, options: { runId: string; aggregateType: string; aggregateId: string }): Promise<any>;
}

export interface ExecutionStorage {
  tenantId: TenantId;
  conversation: DurableExecutionConversationPort;
  providerContinuations: ExecutionProviderContinuationPort;
  memoryCandidates: ExecutionMemoryCandidatePort;
  resultReader: ExecutionResultReader;
  createEventPersister(context: ExecutionRunPersistenceContext): ExecutionEventPersister;
}
