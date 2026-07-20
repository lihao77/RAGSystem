/**
 * conversation-store 行为契约（身份证的能力面）。
 *
 * 手写 IXxxStore 接口照 ops 现有签名（位置参数）逐一定义，签名零改动——位置参数→
 * input 对象的重构留待契约 v2。接口注释标注深合约语义（排序/返回 null/原子性），
 * 为未来多库实现提供可验证的前置/后置（路线图③）。
 *
 * 契约独立：本文件只 import contracts/，绝不 import services/。
 * 实现层 ops `implements IXxxStore`（实现服从契约），而非接口 Pick 派生自实现
 * （旧 contracts.ts 的 `Pick<SessionOps,...>` 是依赖反向的「假身份证」，已废弃）。
 */
import type { PaginatedResult, RunStepInfo } from "../common.js";
import type { TenantId } from "../../identity/types.js";
import type { ExecutionOverview } from "../execution/execution.js";
import type { MessageInfo, SessionInfo, SessionListItem } from "../session/session.js";
import type { PermissionMode } from "../runtime/permissions.js";
import type {
  AddMessageInput,
  AddRunStepInput,
  AgentMetricSummary,
  DailyActivityPoint,
  HeatmapPoint,
  ModelUsagePoint,
  TokenTrendPoint,
  AppendOutboxInput,
  ChildAgentInfo,
  ClaimOutboxInput,
  ConversationStoreTransaction,
  DeleteDeliveredOutboxInput,
  EventOutboxStats,
  ListOutboxInput,
  OutboxRow,
  CreatePendingInteractionInput,
  PendingInteractionRecord,
  PendingInteractionStatus,
  ProviderContinuationRecord,
  PutProviderContinuationInput,
  CreateMemoryCandidateInput,
  MemoryCandidateRecord,
  MemoryCandidateStatus,
  ResourceInfo,
  RetryOutboxBatchInput,
  RetryOutboxResult,
  RunInfo,
  RunStepRecord,
} from "./types.js";

export * from "./types.js";

/**
 * sessions 聚合根。
 * 深合约：getSession 不存在返回 null（非抛异常）；listSessions 按 updated_at 降序、
 * 分页 has_more = offset+limit < total；createSession 幂等（ON CONFLICT 更新）。
 */
export interface ISessionStore {
  createSession(tenantId: TenantId, sessionId: string, userId: string | null, metadata?: Record<string, unknown>, permissionMode?: PermissionMode | null): void;
  getSession(sessionId: string): SessionInfo | null;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Record<string, unknown> | null;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): boolean;
  deleteSession(sessionId: string): boolean;
  listSessions(tenantId: TenantId, limit?: number, offset?: number, userIds?: readonly string[] | null): PaginatedResult<SessionListItem>;
}

/**
 * messages 聚合根。
 * 深合约：listMessages 按 seq 升序返回（内部 DESC 取页后 reverse）；getRecentMessages
 * 默认 thread_key=null 取主线程；不存在均返回 null。addMessage 写入并回读最新行。
 */
export interface IMessageStore {
  addMessage(input: AddMessageInput): MessageInfo;
  insertCompressionMessage(input: {
    sessionId: string;
    summaryContent: string;
    replacesUpToSeq?: number | null;
    threadKey?: string | undefined;
    childAgentId?: string | null | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): MessageInfo;
  listMessages(sessionId: string, limit?: number, offset?: number, threadKey?: string | null): PaginatedResult<MessageInfo>;
  getMessageBySeq(sessionId: string, seq: number): MessageInfo | null;
  getMessageById(sessionId: string, messageId: string): MessageInfo | null;
  getFirstMessageAfterSeq(sessionId: string, seq: number): MessageInfo | null;
  listMessagesAfterSeq(sessionId: string, seq: number, limit?: number): MessageInfo[];
  listMessagesBeforeOrAtSeq(sessionId: string, seq: number, limit?: number): MessageInfo[];
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[];
  deleteMessagesAfter(sessionId: string, input: { afterSeq?: number | null; afterMessageId?: string | null }): number;
  updateMessage(input: {
    messageId: string;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
    sessionId?: string | null;
    roleFilter?: MessageInfo["role"] | null;
  }): boolean;
}

/** Private continuation state for resumable provider tool transactions. */
export interface IProviderContinuationStore {
  putProviderContinuation(input: PutProviderContinuationInput): ProviderContinuationRecord;
  getProviderContinuation(sessionId: string, messageId: string): ProviderContinuationRecord | null;
  deleteProviderContinuations(sessionId: string, threadKey: string): number;
}

/**
 * runs + run_steps 聚合根。
 * 深合约：listRuns/listRunSteps 按 created_at/step_order 降序取最新；addRunStep 的
 * step_order 在 (session_id,run_id) 内自增（COALESCE(MAX)+1）。getRun 不存在返回 null。
 */
export interface IRunStore {
  createRun(input: {
    runId: string;
    sessionId: string;
    entrypoint?: string;
    status?: string;
    taskSummary?: string;
    requestId?: string | null;
    userId?: string | null;
    agentName?: string | null;
    operation?: "publish" | "archive" | null;
    threadKey?: string | null;
    parentRunId?: string | null;
    parentCallId?: string | null;
    childAgentId?: string | null;
  }): {
    run_id: string;
    session_id: string;
    status: string;
    thread_key: string;
    parent_run_id: string | null;
    parent_call_id: string | null;
    child_agent_id: string | null;
  };
  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId?: string | null): boolean;
  getRun(sessionId: string, runId: string): RunInfo | null;
  listRuns(sessionId: string, limit?: number): { items: RunInfo[]; total: number };
  addRunStep(input: AddRunStepInput): RunStepRecord;
  updateRunStepsMessageId(sessionId: string, runId: string, messageId: string): number;
  listRunSteps(input: {
    runId?: string | null;
    messageId?: string | null;
    sessionId?: string | null;
    limit?: number;
  }): RunStepInfo[];
}

/** child_agents 聚合根。深合约：getChildAgent 不存在返回 null。 */
export interface IChildAgentStore {
  createChildAgent(input: {
    childAgentId: string;
    sessionId: string;
    agentName: string;
    threadKey?: string | null;
    createdSeq?: number | null;
    createdByRunId?: string | null;
    createdByCallId?: string | null;
    parentRunId?: string | null;
    parentCallId?: string | null;
    lastRunId?: string | null;
    metadata?: Record<string, unknown>;
    status?: string;
  }): ChildAgentInfo;
  listChildAgents(input: {
    sessionId: string;
    agentName?: string | null;
    operation?: "publish" | "archive" | null;
    limit?: number;
  }): { items: ChildAgentInfo[]; total: number };
  getChildAgent(sessionId: string, childAgentId: string): ChildAgentInfo | null;
  findChildAgentByCreator(input: {
    sessionId: string;
    createdByRunId: string;
    createdByCallId: string;
  }): ChildAgentInfo | null;
  updateChildAgentLastRun(input: {
    sessionId: string;
    childAgentId: string;
    lastRunId: string;
  }): boolean;
}

/**
 * event_outbox + session_event_seq 聚合根。
 * 深合约：nextSessionSeq 在 session_event_seq 上原子自增（INSERT ... ON CONFLICT +
 * UPDATE），跨并发调用唯一递增；claimPendingOutbox 用 locked_at 乐观锁领取。
 */
export interface IOutboxStore {
  getNextSessionSeq(sessionId: string): number;
  appendOutbox(input: AppendOutboxInput): OutboxRow;
  fetchPendingOutbox(limit?: number): OutboxRow[];
  claimPendingOutbox(input?: ClaimOutboxInput): OutboxRow[];
  listOutboxForReplay(input: { sessionId: string; runId?: string | null; runIds?: readonly string[] | null; afterSeq?: number; limit?: number }): OutboxRow[];
  getOutboxRow(id: number): OutboxRow | null;
  listOutbox(input?: ListOutboxInput): PaginatedResult<OutboxRow>;
  markOutboxDelivered(id: number): boolean;
  markOutboxRetrying(id: number, error: string, availableAt: string): boolean;
  markOutboxFailed(id: number, error: string): boolean;
  retryOutbox(id: number, availableAt?: string): boolean;
  retryOutboxBatch(input?: RetryOutboxBatchInput): RetryOutboxResult;
  deleteDeliveredOutbox(input: DeleteDeliveredOutboxInput): number;
  getOutboxStats(): EventOutboxStats;
}

/** Promise-based outbox port used by multi-instance SaaS runtimes. */
export interface AsyncOutboxStore {
  appendOutbox(input: AppendOutboxInput): Promise<OutboxRow>;
  claimPendingOutbox(input?: ClaimOutboxInput): Promise<OutboxRow[]>;
  listOutboxForReplay(input: { tenantId: string; sessionId: string; runIds?: readonly string[] | null; afterSeq?: number; limit?: number }): Promise<OutboxRow[]>;
  markOutboxDelivered(id: number): Promise<boolean>;
  markOutboxRetrying(id: number, error: string, availableAt: string): Promise<boolean>;
  markOutboxFailed(id: number, error: string): Promise<boolean>;
  getOutboxRow(tenantId: string, id: number): Promise<OutboxRow | null>;
  listOutbox(tenantId: string, input?: ListOutboxInput): Promise<PaginatedResult<OutboxRow>>;
  retryOutbox(tenantId: string, id: number, availableAt?: string): Promise<boolean>;
  retryOutboxBatch(tenantId: string, input?: RetryOutboxBatchInput): Promise<RetryOutboxResult>;
  deleteDeliveredOutbox(tenantId: string, input: DeleteDeliveredOutboxInput): Promise<number>;
}

/** resources + step_resources 聚合根 + 执行投影。 */
export interface IResourceStore {
  getPersistedExecutionOverview(activeOnly: boolean, limit?: number): ExecutionOverview;
  registerResource(input: {
    sessionId: string;
    path: string;
    resourceType: string;
    sourceTool?: string;
    runId?: string | null;
    stepId?: number | null;
    messageId?: string | null;
    subType?: string | null;
    title?: string | null;
    scope?: string | null;
    metadata?: Record<string, unknown>;
  }): {
    resource_id: string;
    session_id: string;
    path: string;
    scope: string;
    resource_type: string;
  };
  listResources(sessionId: string, runId?: string | null, limit?: number): { items: ResourceInfo[]; total: number };
  attachResourceToStep(sessionId: string, runId: string, stepId: number, resourceId: string): void;
}

/** agent_call_metrics 聚合根:每次 agent run 的性能指标明细 + 按 agent 聚合。 */
export interface IMetricStore {
  insertMetric(input: {
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
  }): void;
  aggregateMetrics(agentName?: string | null): AgentMetricSummary[];
  resetMetrics(agentName?: string | null): { deleted: number };
  aggregateTokenTrend(opts: { since?: string | null; bucket: "day" | "hour" }): TokenTrendPoint[];
  aggregateModelUsage(opts: { since?: string | null }): ModelUsagePoint[];
  aggregateActivityHeatmap(opts: { since?: string | null }): HeatmapPoint[];
  aggregateDailyActivity(opts: { since?: string | null }): DailyActivityPoint[];
}

/** 用户交互挂起状态；恢复凭证必须跨进程和租户 runtime 回收存活。 */
export interface IPendingInteractionStore {
  createPendingInteraction(input: CreatePendingInteractionInput): PendingInteractionRecord;
  getPendingInteraction(sessionId: string, interactionId: string): PendingInteractionRecord | null;
  listPendingInteractions(input: {
    sessionId: string;
    rootRunId?: string | null;
    batchId?: string | null;
    statuses?: PendingInteractionStatus[];
  }): PendingInteractionRecord[];
  updatePendingInteractionStatus(input: {
    sessionId: string;
    interactionId: string;
    from?: PendingInteractionStatus[];
    status: PendingInteractionStatus;
    resolution?: Record<string, unknown> | null;
  }): boolean;
  /** 仅当 batch 已全部响应时原子领取 resolved 记录；返回 0 表示不可领取或已被领取。 */
  markPendingBatchResuming(sessionId: string, batchId: string): number;
  releasePendingBatch(sessionId: string, batchId: string): number;
  finalizePendingInteractions(sessionId: string, rootRunId: string, status: "completed" | "failed" | "interrupted" | "suspended"): string[];
  suspendPendingInteractions(sessionId: string, rootRunId: string): number;
  consumePendingResolution(sessionId: string, toolCallId: string): PendingInteractionRecord | null;
  cancelPendingInteractions(sessionId: string): number;
}

export interface IMemoryCandidateStore {
  createMemoryCandidate(input: CreateMemoryCandidateInput): MemoryCandidateRecord;
  getMemoryCandidate(id: string): MemoryCandidateRecord | null;
  listMemoryCandidates(input: {
    ownerUserId?: string | null;
    statuses?: MemoryCandidateStatus[];
    targetScope?: "team" | "agent" | null;
    targetScopes?: Array<"team" | "agent">;
    teamName?: string | null;
    agentName?: string | null;
    operation?: "publish" | "archive" | null;
    limit?: number;
    offset?: number;
    contentMaxChars?: number;
  }): MemoryCandidateRecord[];
  countMemoryCandidates(input: {
    ownerUserId?: string | null;
    statuses?: MemoryCandidateStatus[];
    targetScope?: "team" | "agent" | null;
    targetScopes?: Array<"team" | "agent">;
    teamName?: string | null;
    agentName?: string | null;
    operation?: "publish" | "archive" | null;
  }): number;
  claimMemoryCandidate(id: string, reviewerUserId: string): { attemptId: string; claimedAt: string } | null;
  releaseMemoryCandidate(id: string, reviewerUserId: string, attemptId: string): boolean;
  updateMemoryCandidate(input: {
    id: string;
    ownerUserId: string;
    name?: string;
    description?: string;
    content?: string;
    why?: string | null;
    howToApply?: string | null;
  }): boolean;
  reviewMemoryCandidate(input: {
    id: string;
    status: "approved" | "rejected";
    reviewerUserId: string;
    attemptId?: string;
    reviewComment?: string | null;
    publishedFileName?: string | null;
    publishedName?: string;
    publishedDescription?: string;
    publishedContent?: string;
  }): boolean;
  withdrawMemoryCandidate(id: string, ownerUserId: string): boolean;
}

/** 跨域事务运行器（事务原子性独立成契，不可按聚合根拆分）。 */
export interface IConversationTransactionRunner {
  runInTransaction<T>(operation: (tx: ConversationStoreTransaction) => T): T;
}

/**
 * 聚合 store 组合：6 个聚合根窄接口 + 事务运行器 + 组合根级能力。
 * close（生命周期）与 getRecentMessagesByChildAgent（跨 message/child_agent 域）
 * 不属单一窄接口，归组合根。
 */
export interface ConversationStore
  extends ISessionStore,
    IMessageStore,
    IRunStore,
    IChildAgentStore,
    IOutboxStore,
    IResourceStore,
    IProviderContinuationStore,
    IMetricStore,
    IPendingInteractionStore,
    IMemoryCandidateStore,
    IConversationTransactionRunner {
  close(): void;
  getRecentMessagesByChildAgent(sessionId: string, childAgentId: string, limit?: number): MessageInfo[];
}
