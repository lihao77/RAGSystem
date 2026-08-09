import type { PaginatedResult, RunStepInfo } from "../common.js";
import type {
  AddMessageInput,
  AddRunStepInput,
  CreatedRun,
  CreateRunInput,
  DeleteDeliveredOutboxInput,
  ListOutboxInput,
  OutboxRow,
  RetryOutboxBatchInput,
  RetryOutboxResult,
  RunInfo,
  RunStepRecord,
} from "../conversation-store/index.js";
import type { AgentMetricSummary, DailyActivityPoint, HeatmapPoint, ModelUsagePoint, TokenTrendPoint } from "../conversation-store/index.js";
import type { PermissionMode } from "../runtime/permissions.js";
import type {
  CreateSessionRecordInput,
  MessageInfo,
  SessionFacetCounts,
  SessionInfo,
  SessionListProjectionPage,
  SessionListQuery,
  SessionMessageListSnapshot,
} from "../session/session.js";
import type { TenantId } from "../../identity/types.js";

export interface AsyncConversationRepository {
  createSession(input: CreateSessionRecordInput): Promise<void>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  listSessions(input: SessionListQuery): Promise<SessionListProjectionPage>;
  listSessionFacets(input: Pick<SessionListQuery, "tenantId" | "access">): Promise<SessionFacetCounts>;
  addMessage(input: AddMessageInput): Promise<MessageInfo>;
  listMessages(sessionId: string, limit?: number, offset?: number, threadKey?: string | null): Promise<PaginatedResult<MessageInfo>>;
  listVisibleMessagesSnapshot(tenantId: TenantId, sessionId: string, threadKey: string, limit?: number, offset?: number): Promise<SessionMessageListSnapshot>;
  getMessageBySeq(sessionId: string, seq: number): Promise<MessageInfo | null>;
  getMessageById(sessionId: string, id: string): Promise<MessageInfo | null>;
  getFirstMessageAfterSeq(sessionId: string, seq: number): Promise<MessageInfo | null>;
  listMessagesAfterSeq(sessionId: string, seq: number, limit?: number): Promise<MessageInfo[]>;
  listMessagesBeforeOrAtSeq(sessionId: string, seq: number, limit?: number): Promise<MessageInfo[]>;
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  deleteMessagesAfter(sessionId: string, input: { afterSeq?: number | null; afterMessageId?: string | null }): Promise<number>;
  updateMessage(input: { messageId: string; content?: string | null; metadata?: Record<string, unknown> | null; sessionId?: string | null; roleFilter?: MessageInfo["role"] | null }): Promise<boolean>;
  insertCompressionMessage(input: { sessionId: string; summaryContent: string; replacesUpToSeq?: number | null; threadKey?: string; childAgentId?: string | null; metadata?: Record<string, unknown> }): Promise<MessageInfo>;
}

export interface AsyncRunStore {
  createRun(input: CreateRunInput & { tenantId: string }): Promise<CreatedRun>;
  updateRunStatus(tenantId: string, runId: string, sessionId: string, status: string, finalMessageId?: string | null, terminalReason?: string | null): Promise<boolean>;
  getRun(tenantId: string, sessionId: string, runId: string): Promise<RunInfo | null>;
  listRuns(tenantId: string, sessionId: string, limit?: number): Promise<{ items: RunInfo[]; total: number }>;
  listParticipantRuns(tenantId: string, sessionId: string, participantId: string, limit: number, offset: number): Promise<{ items: RunInfo[]; total: number }>;
  interruptSuspendedRuns(tenantId: string, sessionId: string): Promise<RunInfo[]>;
  addRunStep(input: AddRunStepInput & { tenantId: string }): Promise<RunStepRecord>;
  updateRunStepsMessageId(tenantId: string, sessionId: string, runId: string, messageId: string): Promise<number>;
  listRunSteps(input: { tenantId: string; runId?: string | null; messageId?: string | null; sessionId?: string | null; limit?: number }): Promise<RunStepInfo[]>;
  getTenantRun(tenantId: string, runId: string): Promise<RunInfo | null>;
  listTenantRuns(tenantId: string, activeOnly: boolean): Promise<RunInfo[]>;
}

export interface AsyncAnalyticsRepository {
  insertMetric(tenantId: string, input: AnalyticsMetricInput): Promise<void>;
  aggregateTokenTrend(tenantId: string, input: { since: string; bucket: "day" | "hour" }): Promise<TokenTrendPoint[]>;
  aggregateModelUsage(tenantId: string, input: { since: string }): Promise<ModelUsagePoint[]>;
  aggregateActivityHeatmap(tenantId: string, input: { since: string }): Promise<HeatmapPoint[]>;
  aggregateDailyActivity(tenantId: string, input: { since: string }): Promise<DailyActivityPoint[]>;
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
  retryOutbox(tenantId: string, id: number): Promise<boolean>;
  retryOutboxBatch(tenantId: string, input?: RetryOutboxBatchInput): Promise<RetryOutboxResult>;
  deleteDeliveredOutbox(tenantId: string, input: DeleteDeliveredOutboxInput): Promise<number>;
}
