import type { ProviderContinuationState } from "@ragsystem/agent-llm";
import type { KernelEvent } from "@ragsystem/agent-sdk";

import type { ConversationStore } from "../conversation-store/index.js";
import type { Envelope } from "../events.js";
import type { MessageInfo, SessionInfo } from "../session/session.js";
import type { TenantId } from "../../identity/types.js";

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
}

export interface ExecutionEventPersister {
  startRun(): void | Promise<void>;
  persist(event: KernelEvent): void | Promise<void>;
  finalize(status: "completed" | "failed" | "interrupted" | "suspended", finalMessage: { id?: string; content: string; metadata?: Record<string, unknown> } | null, error?: unknown): { readyResumeInteractionIds: string[] } | Promise<{ readyResumeInteractionIds: string[] }>;
  resolveFinalMessage(): { id: string; seq: number; content: string } | null | Promise<{ id: string; seq: number; content: string } | null>;
}

export interface DurableExecutionConversationPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  insertCompressionMessage(input: { sessionId: string; summaryContent: string; replacesUpToSeq?: number | null; threadKey?: string; childAgentId?: string | null; metadata?: Record<string, unknown> }): Promise<MessageInfo>;
}

export interface DurableExecutionProviderContinuationPort {
  getProviderContinuation(tenantId: TenantId, sessionId: string, messageId: string): Promise<{ state: ProviderContinuationState } | null>;
}

export interface DurableExecutionClientEventPort {
  publish(sessionId: string, event: Envelope, options: { runId: string; aggregateType: string; aggregateId: string }): Promise<any>;
}

/** Deployment-neutral execution persistence boundary. The two implementations are exclusive. */
export type ExecutionStorage =
  | {
      kind: "local";
      tenantId: TenantId;
      conversation: ConversationStore;
      createEventPersister(context: ExecutionRunPersistenceContext): ExecutionEventPersister;
    }
  | {
      kind: "durable";
      tenantId: TenantId;
      conversation: DurableExecutionConversationPort;
      providerContinuations: DurableExecutionProviderContinuationPort;
      clientEvents: DurableExecutionClientEventPort;
      createEventPersister(context: ExecutionRunPersistenceContext): ExecutionEventPersister;
    };
