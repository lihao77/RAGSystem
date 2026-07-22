import type { Envelope } from "@ragsystem/agent-protocol";

import type { PaginatedResult } from "../common.js";
import type { PermissionMode } from "../runtime/permissions.js";
import type { MessageInfo, SessionInfo, SessionListItem } from "../session/session.js";
import type { TenantId } from "../../identity/types.js";
import type { ListMemoryCandidatesInput, MemoryCandidateRecord } from "../conversation-store/index.js";

/**
 * Execution-only session port.  Unlike SessionApplication this intentionally
 * contains only the operations used while launching a run.  Implementations
 * may be fully asynchronous (for example the SaaS PostgreSQL adapter).
 */
export interface ExecutionSessionPort {
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  createSession(input: { tenantId: TenantId; sessionId: string; userId: string; metadata?: Record<string, unknown> }): Promise<unknown>;
  createSystemSession(input: { tenantId: TenantId; sessionId: string; metadata?: Record<string, unknown> }): Promise<unknown>;
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
  }): Promise<MessageInfo>;
  getMessageForRetry(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<MessageInfo | null>;
  getLastRunRound(sessionId: string, runId: string): Promise<number>;
  prepareRetry(input: {
    sessionId: string;
    afterSeq?: number | null;
    afterMessageId?: string | null;
    modifyUserMessage?: string | null;
    metadataPatch?: { attachments?: unknown[]; extensions?: unknown[] };
  }): Promise<{ deleted: number; task: string; message: MessageInfo }>;
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
  ensureSession(input: { sessionId: string; userId: string; metadata?: Record<string, unknown>; permissionMode?: PermissionMode | null }): Promise<void>;
  createSession(input: { sessionId: string; userId: string; metadata?: Record<string, unknown>; permissionMode?: PermissionMode | null }): Promise<{
    session_id: string;
    user_id: string | null;
    permission_mode: PermissionMode | null;
    metadata: Record<string, unknown>;
  }>;
  listSessions(input: { limit?: number; offset?: number; userIds?: readonly string[] | null }): Promise<PaginatedResult<SessionListItem>>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  getSessionForExecutionValidation(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  listMessages(input: { sessionId: string; limit?: number; offset?: number }): Promise<PaginatedResult<MessageInfo> | null>;
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  getMessageForRetry(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<MessageInfo | null>;
  listMemoryCandidates(input: ListMemoryCandidatesInput): Promise<MemoryCandidateRecord[]>;
  listMessageRunSteps(input: { sessionId: string; messageId: string; limit?: number; offset?: number }): Promise<{
    message_id: string;
    items: Envelope[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  }>;
  updateUserMessage(input: { sessionId: string; messageId: string; content: string }): Promise<boolean>;
  rollbackMessages(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<number>;
  exportSession(sessionId: string): Promise<SessionExport>;
}
