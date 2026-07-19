import type { ProviderContinuationState } from "@ragsystem/agent-llm";

import type { PaginatedResult, RunStepInfo } from "../common.js";
import type {
  AddMessageInput,
  AddRunStepInput,
  DeleteDeliveredOutboxInput,
  ListOutboxInput,
  OutboxRow,
  RetryOutboxBatchInput,
  RetryOutboxResult,
  RunInfo,
  RunStepRecord,
  CreatePendingInteractionInput,
  PendingInteractionRecord,
  PendingInteractionStatus,
} from "../conversation-store/index.js";
import type { DailyActivityPoint, HeatmapPoint, ModelUsagePoint, TokenTrendPoint } from "../conversation-store/index.js";
import type { PermissionMode } from "../runtime/permissions.js";
import type { MessageInfo, SessionInfo, SessionListItem } from "../session/session.js";
import type { TenantId } from "../../identity/types.js";

export interface AsyncConversationRepository {
  createSession(tenantId: TenantId, sessionId: string, userId: string | null, metadata?: Record<string, unknown>, permissionMode?: PermissionMode | null): Promise<void>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  listSessions(tenantId: TenantId, limit?: number, offset?: number, userIds?: readonly string[] | null): Promise<PaginatedResult<SessionListItem>>;
  addMessage(input: AddMessageInput): Promise<MessageInfo>;
  listMessages(sessionId: string, limit?: number, offset?: number, threadKey?: string | null): Promise<PaginatedResult<MessageInfo>>;
  listVisibleRootMessages(sessionId: string, limit?: number, offset?: number): Promise<PaginatedResult<MessageInfo>>;
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
  createRun(input: AddRunInput & { tenantId: string }): Promise<CreatedRun>;
  updateRunStatus(tenantId: string, runId: string, sessionId: string, status: string, finalMessageId?: string | null): Promise<boolean>;
  getRun(tenantId: string, sessionId: string, runId: string): Promise<RunInfo | null>;
  listRuns(tenantId: string, sessionId: string, limit?: number): Promise<{ items: RunInfo[]; total: number }>;
  interruptSuspendedRuns(tenantId: string, sessionId: string): Promise<RunInfo[]>;
  addRunStep(input: AddRunStepInput & { tenantId: string }): Promise<RunStepRecord>;
  updateRunStepsMessageId(tenantId: string, sessionId: string, runId: string, messageId: string): Promise<number>;
  listRunSteps(input: { tenantId: string; runId?: string | null; messageId?: string | null; sessionId?: string | null; limit?: number }): Promise<RunStepInfo[]>;
  getTenantRun(tenantId: string, runId: string): Promise<RunInfo | null>;
  listTenantRuns(tenantId: string, activeOnly: boolean): Promise<RunInfo[]>;
}

type AddRunInput = Parameters<import("../conversation-store/index.js").IRunStore["createRun"]>[0];
type CreatedRun = ReturnType<import("../conversation-store/index.js").IRunStore["createRun"]>;

export interface AsyncAnalyticsRepository {
  insertMetric(tenantId: string, input: AnalyticsMetricInput): Promise<void>;
  aggregateTokenTrend(tenantId: string, input: { since: string; bucket: "day" | "hour" }): Promise<TokenTrendPoint[]>;
  aggregateModelUsage(tenantId: string, input: { since: string }): Promise<ModelUsagePoint[]>;
  aggregateActivityHeatmap(tenantId: string, input: { since: string }): Promise<HeatmapPoint[]>;
  aggregateDailyActivity(tenantId: string, input: { since: string }): Promise<DailyActivityPoint[]>;
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

export interface AsyncProviderContinuationRepository {
  getProviderContinuation(tenantId: TenantId, sessionId: string, messageId: string): Promise<{ state: ProviderContinuationState } | null>;
}

export interface AsyncProviderContinuationStore {
  getProviderContinuation(tenantId: TenantId, sessionId: string, messageId: string): Promise<import("../conversation-store/index.js").ProviderContinuationRecord | null>;
}

export interface AsyncPendingInteractionStore {
  getPendingInteraction(sessionId: string, interactionId: string): Promise<PendingInteractionRecord | null>;
  listPendingInteractions(input: { sessionId: string; rootRunId?: string | null; batchId?: string | null; statuses?: PendingInteractionStatus[] }): Promise<PendingInteractionRecord[]>;
  updatePendingInteractionStatus(input: { sessionId: string; interactionId: string; from?: PendingInteractionStatus[]; status: PendingInteractionStatus; resolution?: Record<string, unknown> | null }): Promise<boolean>;
  cancelPendingInteractions(sessionId: string): Promise<number>;
  createPendingInteraction?(input: CreatePendingInteractionInput): Promise<PendingInteractionRecord>;
}
