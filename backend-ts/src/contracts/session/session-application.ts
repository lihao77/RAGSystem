import type { Envelope } from "@ragsystem/agent-protocol";

import type { PaginatedResult } from "../common.js";
import type { PermissionMode } from "../runtime/permissions.js";
import type { MessageInfo, SessionInfo, SessionListItem } from "../session/session.js";
import type { TenantId } from "../../identity/types.js";
import type { ConversationStore } from "../conversation-store/index.js";

export type Awaitable<T> = T | Promise<T>;

/**
 * Execution-only session port.  Unlike SessionApplication this intentionally
 * contains only the operations used while launching a run.  Implementations
 * may be fully asynchronous (for example the SaaS PostgreSQL adapter).
 */
export interface ExecutionSessionPort {
  getSession(sessionId: string): Awaitable<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Awaitable<Record<string, unknown> | null>;
  createSession(input: { tenantId: TenantId; sessionId: string; userId: string; metadata?: Record<string, unknown> }): Awaitable<unknown>;
  createSystemSession(input: { tenantId: TenantId; sessionId: string; metadata?: Record<string, unknown> }): Awaitable<unknown>;
  addMessage(input: {
    sessionId: string;
    role: MessageInfo["role"];
    content: string;
    metadata?: Record<string, unknown>;
    toolCalls?: MessageInfo["tool_calls"];
    toolCallId?: string;
    name?: string;
    messageId?: string;
    threadKey?: string;
    childAgentId?: string | null;
  }): Awaitable<MessageInfo>;
  getMessageForRetry(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Awaitable<MessageInfo | null>;
  getLastRunRound(sessionId: string, runId: string): Awaitable<number>;
  prepareRetry(input: {
    sessionId: string;
    afterSeq?: number | null;
    afterMessageId?: string | null;
    modifyUserMessage?: string | null;
    metadataPatch?: { attachments?: unknown[]; extensions?: unknown[] };
  }): Awaitable<{ deleted: number; task: string; message: MessageInfo }>;
}

export interface SessionExport {
  version: number;
  exported_at: string;
  session: SessionInfo;
  messages: Array<MessageInfo & { execution_events?: Envelope[] }>;
  message_count: number;
}

/** Request-scoped session use cases shared by Local and SaaS deployments. */
export interface SessionApplication {
  ensureSession(input: { sessionId: string; userId: string; metadata?: Record<string, unknown>; permissionMode?: PermissionMode | null }): Awaitable<void>;
  createSession(input: { sessionId: string; userId: string; metadata?: Record<string, unknown>; permissionMode?: PermissionMode | null }): Awaitable<{
    session_id: string;
    user_id: string | null;
    permission_mode: PermissionMode | null;
    metadata: Record<string, unknown>;
  }>;
  listSessions(input: { limit?: number; offset?: number; userIds?: readonly string[] | null }): Awaitable<PaginatedResult<SessionListItem>>;
  getSession(sessionId: string): Awaitable<SessionInfo | null>;
  getSessionForExecutionValidation(sessionId: string): Awaitable<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Awaitable<Record<string, unknown>>;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Awaitable<boolean>;
  deleteSession(sessionId: string): Awaitable<boolean>;
  listMessages(input: { sessionId: string; limit?: number; offset?: number }): Awaitable<PaginatedResult<MessageInfo> | null>;
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Awaitable<MessageInfo[]>;
  getMessageForRetry(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Awaitable<MessageInfo | null>;
  listMemoryCandidates(
    input: Parameters<ConversationStore["listMemoryCandidates"]>[0],
  ): Awaitable<ReturnType<ConversationStore["listMemoryCandidates"]>>;
  listMessageRunSteps(input: { sessionId: string; messageId: string; limit?: number; offset?: number }): Awaitable<{
    message_id: string;
    items: Envelope[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  }>;
  updateUserMessage(input: { sessionId: string; messageId: string; content: string }): Awaitable<boolean>;
  rollbackMessages(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Awaitable<number>;
  exportSession(sessionId: string): Awaitable<SessionExport>;
}
