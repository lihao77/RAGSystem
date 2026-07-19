import type { Envelope } from "@ragsystem/agent-protocol";

import type { PaginatedResult } from "../common.js";
import type { PermissionMode } from "../permissions.js";
import type { MessageInfo, SessionInfo, SessionListItem } from "../session/session.js";

export type Awaitable<T> = T | Promise<T>;

export interface SessionExport {
  version: number;
  exported_at: string;
  session: SessionInfo;
  messages: Array<MessageInfo & { execution_events?: Envelope[] }>;
  message_count: number;
}

/** Request-scoped session use cases shared by Local and SaaS deployments. */
export interface SessionApplication {
  createSession(input: { sessionId: string; userId: string; metadata?: Record<string, unknown>; permissionMode?: PermissionMode | null }): Awaitable<{
    session_id: string;
    user_id: string | null;
    permission_mode: PermissionMode | null;
    metadata: Record<string, unknown>;
  }>;
  listSessions(input: { limit?: number; offset?: number; userIds?: readonly string[] | null }): Awaitable<PaginatedResult<SessionListItem>>;
  getSession(sessionId: string): Awaitable<SessionInfo | null>;
  getSessionForExecutionValidation(sessionId: string): Awaitable<SessionInfo | null>;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Awaitable<boolean>;
  deleteSession(sessionId: string): Awaitable<boolean>;
  listMessages(input: { sessionId: string; limit?: number; offset?: number }): Awaitable<PaginatedResult<MessageInfo> | null>;
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Awaitable<MessageInfo[]>;
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
