import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type { PaginatedResult } from "../common.js";
import type {
  AddMessageInput,
  CreatedRun,
  CreateRunInput,
  DeleteDeliveredOutboxInput,
  ListOutboxInput,
  MessageFeedback,
  MessageFeedbackValue,
  OutboxRow,
  RetryOutboxBatchInput,
  RetryOutboxResult,
  RunInfo,
} from "../conversation-store/index.js";
import type { AgentMetricSummary, DailyActivityPoint, HeatmapPoint, ModelUsagePoint, TokenTrendPoint } from "../conversation-store/index.js";
import type { PermissionMode } from "../runtime/permissions.js";
import type {
  CreateSessionRecordInput,
  MessageInfo,
  SessionFacetCounts,
  SessionInfo,
  SessionListProjection,
  SessionListProjectionPage,
  SessionListQuery,
  SessionMessageListSnapshot,
  SessionTeamSnapshot,
} from "../session/session.js";
import type { TenantId } from "../../identity/types.js";

export interface AsyncConversationRepository {
  createSession(input: CreateSessionRecordInput): Promise<void>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** 锚定回填：仅对 team_snapshot 仍为 NULL 的存量行生效，幂等。 */
  anchorSessionTeamSnapshot(sessionId: string, snapshot: SessionTeamSnapshot): Promise<boolean>;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  listSessions(input: SessionListQuery): Promise<SessionListProjectionPage>;
  listSessionFacets(input: Pick<SessionListQuery, "tenantId" | "access">): Promise<SessionFacetCounts>;
  /** 单会话列表投影（title 回显等轻量读取）。 */
  getSessionListProjection(sessionId: string): Promise<SessionListProjection | null>;
  addMessage(input: AddMessageInput): Promise<MessageInfo>;
  listMessages(sessionId: string, limit?: number, offset?: number, threadKey?: string | null): Promise<PaginatedResult<MessageInfo>>;
  listVisibleMessagesSnapshot(tenantId: TenantId, sessionId: string, threadKey: string, limit?: number, offset?: number): Promise<SessionMessageListSnapshot>;
  getMessageBySeq(sessionId: string, seq: number): Promise<MessageInfo | null>;
  getMessageById(sessionId: string, id: string): Promise<MessageInfo | null>;
  getFirstMessageAfterSeq(sessionId: string, seq: number): Promise<MessageInfo | null>;
  listMessagesAfterSeq(sessionId: string, seq: number, limit?: number): Promise<MessageInfo[]>;
  listMessagesBeforeOrAtSeq(sessionId: string, seq: number, limit?: number): Promise<MessageInfo[]>;
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  deleteMessagesAfter(sessionId: string, input: {
    afterSeq?: number | null;
    afterMessageId?: string | null;
    tenantId?: string | null;
  }): Promise<number>;
  updateMessage(input: { messageId: string; contentParts?: MessageContentPart[] | null; metadata?: Record<string, unknown> | null; sessionId?: string | null; roleFilter?: MessageInfo["role"] | null }): Promise<boolean>;
  insertCompressionMessage(input: { sessionId: string; summaryContent: string; replacesUpToSeq?: number | null; threadKey?: string; childAgentId?: string | null; metadata?: Record<string, unknown> }): Promise<MessageInfo>;
}

export interface AsyncRunStore {
  createRun(input: CreateRunInput & { tenantId: string }): Promise<CreatedRun>;
  updateRunStatus(tenantId: string, runId: string, sessionId: string, status: string, finalMessageId?: string | null, terminalReason?: string | null): Promise<boolean>;
  getRun(tenantId: string, sessionId: string, runId: string): Promise<RunInfo | null>;
  listRuns(tenantId: string, sessionId: string, limit?: number): Promise<{ items: RunInfo[]; total: number }>;
  listParticipantRuns(tenantId: string, sessionId: string, participantId: string, limit: number, offset: number): Promise<{ items: RunInfo[]; total: number }>;
  interruptSuspendedRuns(tenantId: string, sessionId: string): Promise<RunInfo[]>;
  getTenantRun(tenantId: string, runId: string): Promise<RunInfo | null>;
  listTenantRuns(tenantId: string, activeOnly: boolean): Promise<RunInfo[]>;
}

export interface AsyncAnalyticsRepository {
  insertMetric(tenantId: string, input: AnalyticsMetricInput): Promise<void>;
  aggregateTokenTrend(tenantId: string, input: { since: string; bucket: "day" | "hour"; timeZone?: string }): Promise<TokenTrendPoint[]>;
  aggregateModelUsage(tenantId: string, input: { since: string }): Promise<ModelUsagePoint[]>;
  aggregateActivityHeatmap(tenantId: string, input: { since: string; timeZone?: string }): Promise<HeatmapPoint[]>;
  aggregateDailyActivity(tenantId: string, input: { since: string; timeZone?: string }): Promise<DailyActivityPoint[]>;
}

/** Runtime metrics surface; separate from chart-only analytics consumers. */
export interface AsyncAgentMetricsRepository {
  insertMetric(tenantId: string, input: AnalyticsMetricInput): Promise<void>;
  aggregateMetrics(tenantId: string, agentName?: string | null): Promise<AgentMetricSummary[]>;
  resetMetrics(tenantId: string, agentName?: string | null): Promise<{ deleted: number }>;
}

export interface AnalyticsMetricInput {
  agentName: string;
  model?: string;
  sessionId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  executionKind: string;
  status: string;
  durationMs: number;
  tokenIn?: number;
  tokenOut?: number;
  toolUsage?: Record<string, number>;
  errorType?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export type ExecutionSessionReadRepositoryPort = Pick<AsyncConversationRepository, "getSession">;
export type ExecutionRunReadRepositoryPort = Pick<AsyncRunStore, "listRuns" | "getTenantRun" | "listTenantRuns">;

export interface ExecutionReplayRepositoryPort {
  listOutboxForReplay(input: { tenantId: string; sessionId: string; runIds?: readonly string[] | null; afterSeq?: number; limit?: number }): Promise<OutboxRow[]>;
  getSessionOutboxWatermark(tenantId: string, sessionId: string): Promise<number>;
}

export type AnalyticsRepositoryPort = Pick<AsyncAnalyticsRepository,
  "aggregateTokenTrend" | "aggregateModelUsage" | "aggregateActivityHeatmap" | "aggregateDailyActivity">;

export interface MonitoringRepositoryPort {
  listOutbox(tenantId: string, input?: ListOutboxInput): Promise<PaginatedResult<OutboxRow>>;
  getOutboxRow(tenantId: string, id: number): Promise<OutboxRow | null>;
  retryOutbox(tenantId: string, id: number, availableAt?: string): Promise<boolean>;
  retryOutboxBatch(tenantId: string, input?: RetryOutboxBatchInput): Promise<RetryOutboxResult>;
  deleteDeliveredOutbox(tenantId: string, input?: DeleteDeliveredOutboxInput): Promise<number>;
}

/**
 * 消息级赞/踩反馈存储端口。独立于 AsyncConversationRepository：
 * 反馈是会话域自身的元数据（评价引用，不含消息内容），生命周期不随任何插件。
 * set 语义为幂等 upsert（每条消息至多一条，后写覆盖）；clear 删除。
 */
export interface AsyncMessageFeedbackStore {
  setMessageFeedback(input: {
    sessionId: string;
    messageId: string;
    tenantId: TenantId;
    value: MessageFeedbackValue;
    comment?: string | null;
    userId?: string | null;
  }): Promise<MessageFeedback>;
  clearMessageFeedback(input: { sessionId: string; messageId: string }): Promise<boolean>;
  listMessageFeedback(sessionId: string): Promise<MessageFeedback[]>;
  /** 租户级被踩清单（按更新时间倒序）：监控/智能体构建失败回流的查询入口。 */
  listNegativeMessageFeedback(tenantId: TenantId, options?: { since?: string; limit?: number }): Promise<MessageFeedback[]>;
}
