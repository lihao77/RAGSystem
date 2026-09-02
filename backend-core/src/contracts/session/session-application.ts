import type { Envelope, MessageContentPart } from "@ragsystem/agent-protocol";

import type { PermissionMode } from "../runtime/permissions.js";
import type { MessageFeedback, MessageFeedbackValue, RunInfo } from "../conversation-store/index.js";
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
 * 会话域条目不存在（消息/Run/会话）。路由层据此映射 404；
 * 其余 service 错误走 500，避免内部故障被伪装成"资源不存在"。
 */
export class SessionItemNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionItemNotFoundError";
  }
}

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
}

export interface SessionExport {
  version: number;
  exported_at: string;
  session: SessionInfo;
  messages: Array<MessageInfo & { execution_events?: Envelope[] }>;
  message_count: number;
}

export interface SessionParticipantRunSummary {
  run_id: string;
  status: string;
  task_summary: string | null;
  final_message_id: string | null;
  created_at: string;
  updated_at: string;
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
  /** 执行视图（消息行合成）：从本 run 的消息行重建执行树 envelope 流（思考=thinking part）。 */
  listMessageExecution(input: { sessionId: string; messageId: string; threadKey?: string | null }): Promise<{
    message_id: string;
    items: Envelope[];
    total: number;
  }>;
  listParticipantRuns(input: { sessionId: string; participantId: string; limit?: number; offset?: number }): Promise<{
    items: SessionParticipantRunSummary[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  }>;
  listParticipantRunExecutionSteps(input: { sessionId: string; participantId: string; runId: string; limit?: number; offset?: number }): Promise<{
    run_id: string;
    items: Envelope[];
    total: number;
    limit: number;
    offset: number;
    has_more: boolean;
  }>;
  updateUserMessage(input: { sessionId: string; messageId: string; content: string }): Promise<boolean>;
  /** 消息赞/踩：仅助手消息可评价；消息不存在或不可评价时返回 null（路由层映射 404）。 */
  setMessageFeedback(input: { sessionId: string; messageId: string; value: MessageFeedbackValue; comment?: string | null; userId?: string | null }): Promise<MessageFeedback | null>;
  clearMessageFeedback(input: { sessionId: string; messageId: string }): Promise<boolean>;
  listMessageFeedback(sessionId: string): Promise<MessageFeedback[]>;
  /** 租户级被踩清单（按更新时间倒序）：智能体构建失败回流按团队过滤消费。 */
  listNegativeMessageFeedback(input?: { since?: string; limit?: number }): Promise<MessageFeedback[]>;
  /** 会话 run 清单（含子 run）：失败回流按 final_message_id 关联被踩消息的运行状态。 */
  listRuns(sessionId: string, limit?: number): Promise<RunInfo[]>;
  rollbackMessages(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<number>;
  exportSession(sessionId: string): Promise<SessionExport>;
}
