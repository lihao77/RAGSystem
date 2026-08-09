import type { Envelope, MessageContentPart } from "@ragsystem/agent-protocol";

import type { PermissionMode } from "../runtime/permissions.js";
import type {
  CreateSessionRecordInput,
  MessageInfo,
  SessionFacetCounts,
  SessionInfo,
  SessionListProjectionPage,
  SessionListQuery,
  SessionIdentity,
  SessionCreateInput,
  SessionMessageListSnapshot,
} from "../session/session.js";
import type { TenantId } from "../../identity/types.js";
import type { WorkspaceRecord } from "../workspace/workspace.js";

/**
 * Execution-only session port.  Unlike SessionApplication this intentionally
 * contains only the operations used while launching a run.  Implementations
 * may be fully asynchronous (for example the SaaS PostgreSQL adapter).
 */
export interface ExecutionSessionPort {
  getSession(sessionId: string): Promise<SessionInfo | null>;
  resolveWorkspaceRoot(sessionId: string): Promise<string | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  createSession(input: CreateSessionRecordInput): Promise<unknown>;
  createSystemSession(input: { tenantId: TenantId; sessionId: string; metadata?: Record<string, unknown> }): Promise<unknown>;
  addMessage(input: {
    sessionId: string;
    role: MessageInfo["role"];
    content: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown>;
    toolCalls?: MessageInfo["tool_calls"];
    toolCallId?: string;
    name?: string;
    messageId?: string;
    threadKey?: string;
    childAgentId?: string | null;
  }): Promise<MessageInfo>;
  getMessageForRetry(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<MessageInfo | null>;
  rollbackMessages(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<number>;
  getLastRunRound(sessionId: string, runId: string): Promise<number>;
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
  ensureSession(input: SessionIdentity): Promise<void>;
  createSession(input: SessionCreateInput): Promise<SessionInfo>;
  listSessions(input: Omit<SessionListQuery, "tenantId">): Promise<SessionListProjectionPage>;
  listSessionFacets(input: Pick<SessionListQuery, "access">): Promise<SessionFacetCounts>;
  listWorkspacesByIds(workspaceIds: readonly string[]): Promise<WorkspaceRecord[]>;
  listWorkspaces(): Promise<WorkspaceRecord[]>;
  removeWorkspace(workspaceId: string): Promise<boolean>;
  resolveWorkspace(input: { kind: "local_path"; root_path: string } | { kind: "existing"; workspace_id: string } | null | undefined): Promise<string | null>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  resolveWorkspaceRoot(sessionId: string): Promise<string | null>;
  getSessionForExecutionValidation(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  listMessages(input: { sessionId: string; limit?: number; offset?: number; threadKey?: string | null }): Promise<SessionMessageListSnapshot | null>;
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  getMessageForRetry(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<MessageInfo | null>;
  listMessageRunSteps(input: { sessionId: string; messageId: string; limit?: number; offset?: number; threadKey?: string | null }): Promise<{
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
