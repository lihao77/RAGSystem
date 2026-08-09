/**
 * conversation-store 数据契约（身份证的数据面）。
 *
 * 分层原则：
 * - 输入边界（*Input）用 zod schema 定义 → z.infer 产出类型，既给编译期类型，
 *   也给运行时入口校验（见 ops 边界 parse）。schema 字段与历史 interface 逐一对应，
 *   不收紧历史数据（metadata/payload 用 z.record(z.unknown()) 宽松，避免拒历史行）。
 * - 输出/领域类型现已全部用 zod schema + z.infer 单源定义，与输入边界一致。
 *
 * 契约独立：本文件只 import contracts/ 内其他文件（session），绝不 import services/。
 * Shared async ports and Local adapters both consume these DTOs; storage behavior
 * itself is defined at the deployment boundary.
 */
import { z } from "zod";
import type { ProviderContinuationState } from "@ragsystem/agent-llm";
import { MessageContentPartSchema } from "@ragsystem/agent-protocol";


// ────────────────────────────── 共享枚举 ──────────────────────────────

export const OutboxStatusSchema = z.enum(["pending", "retrying", "delivered", "failed"]);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

export const PendingInteractionStatusSchema = z.enum([
  "waiting",
  "suspended",
  "resolved",
  "resuming",
  "consumed",
  "cancelled",
]);
export type PendingInteractionStatus = z.infer<typeof PendingInteractionStatusSchema>;

export interface PendingInteractionRecord {
  interaction_id: string;
  session_id: string;
  run_id: string;
  root_run_id: string;
  tool_call_id: string;
  batch_id: string;
  kind: "approval" | "user_input";
  status: PendingInteractionStatus;
  request_payload: Record<string, unknown>;
  resolution_payload: Record<string, unknown> | null;
  resume_claim_id: string | null;
  resume_claim_expires_at?: string | null;
  created_at: string;
  updated_at: string;
  responded_at: string | null;
  consumed_at: string | null;
}

export interface CreatePendingInteractionInput {
  interactionId: string;
  sessionId: string;
  runId: string;
  rootRunId: string;
  toolCallId: string;
  batchId: string;
  kind: "approval" | "user_input";
  requestPayload: Record<string, unknown>;
}

/** Private provider state bound to an assistant tool-call message. Never exposed as message metadata. */
export interface ProviderContinuationRecord {
  message_id: string;
  session_id: string;
  thread_key: string;
  provider_type: string;
  tool_call_ids: string[];
  state: ProviderContinuationState;
  created_at: string;
}

export interface PutProviderContinuationInput {
  messageId: string;
  sessionId: string;
  threadKey: string;
  providerType: string;
  toolCallIds: string[];
  state: ProviderContinuationState;
}

// ────────────────────────────── 输入边界（zod schema + z.infer） ──────────────────────────────
// TODO 校验覆盖一致性：当前仅 addMessage/appendOutbox 入口 parse，其余 *Input 仅定义形状；
// 运行时校验待统一接入（事务 facade 与 ops 间内部调用信任输入）。契约 v2（位置参数→input）一并处理。

const MessageToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const AddMessageInputSchema = z.object({
  sessionId: z.string(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  contentParts: z.array(MessageContentPartSchema),
  metadata: z.record(z.unknown()).optional(),
  toolCalls: z.array(MessageToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  messageId: z.string().optional(),
  threadKey: z.string().optional(),
  childAgentId: z.string().nullable().optional(),
});
export type AddMessageInput = z.infer<typeof AddMessageInputSchema>;

export interface CreateRunInput {
  runId: string;
  sessionId: string;
  entrypoint?: string;
  status?: string;
  taskSummary?: string;
  requestId?: string | null;
  userId?: string | null;
  agentName?: string | null;
  agentCallId: string;
  lineageParentCallId: string | null;
  agentDisplayName: string;
  leaseRootRunId: string;
  operation?: "publish" | "archive" | null;
  threadKey?: string | null;
  parentRunId?: string | null;
  parentCallId?: string | null;
  childAgentId?: string | null;
}

export interface CreatedRun {
  run_id: string;
  session_id: string;
  status: string;
  thread_key: string;
  parent_run_id: string | null;
  parent_call_id: string | null;
  agent_call_id: string;
  lineage_parent_call_id: string | null;
  agent_display_name: string;
  lease_root_run_id: string;
  child_agent_id: string | null;
}

export interface CreateChildAgentInput {
  childAgentId: string;
  sessionId: string;
  agentName: string;
  threadKey?: string | null;
  /** Runtime participant that owns this child; null means the session root Agent. */
  parentParticipantId?: string | null;
  createdSeq?: number | null;
  createdByRunId?: string | null;
  createdByCallId?: string | null;
  parentRunId?: string | null;
  parentCallId?: string | null;
  lastRunId?: string | null;
  metadata?: Record<string, unknown>;
  status?: string;
}

export interface FindChildAgentByCreatorInput {
  sessionId: string;
  createdByRunId: string;
  createdByCallId: string;
  parentParticipantId?: string | null;
}

export interface ListChildAgentsInput {
  sessionId: string;
  agentName?: string | null;
  parentParticipantId?: string | null;
  operation?: "publish" | "archive" | null;
  limit?: number;
}

export interface UpdateChildAgentLastRunInput {
  sessionId: string;
  childAgentId: string;
  lastRunId: string;
}

export const AddRunStepInputSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
  eventId: z.string().trim().min(1).optional(),
  stepType: z.string(),
  payload: z.record(z.unknown()),
  messageId: z.string().nullable().optional(),
});
export type AddRunStepInput = z.infer<typeof AddRunStepInputSchema>;

export const AppendOutboxInputSchema = z.object({
  sessionId: z.string(),
  runId: z.string().nullable().optional(),
  eventId: z.string().optional(),
  sessionSeq: z.number().optional(),
  eventType: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  payload: z.record(z.unknown()),
  availableAt: z.string().nullable().optional(),
});
export type AppendOutboxInput = z.infer<typeof AppendOutboxInputSchema>;

export const ClaimOutboxInputSchema = z.object({
  tenantId: z.string().optional(),
  limit: z.number().optional(),
  lockTimeoutMs: z.number().optional(),
  now: z.date().optional(),
});
export type ClaimOutboxInput = z.infer<typeof ClaimOutboxInputSchema>;

export const ListOutboxInputSchema = z.object({
  statuses: z.array(OutboxStatusSchema).optional(),
  sessionId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});
export type ListOutboxInput = z.infer<typeof ListOutboxInputSchema>;

export const RetryOutboxBatchInputSchema = z.object({
  ids: z.array(z.number()).optional(),
  statuses: z.array(OutboxStatusSchema).optional(),
  limit: z.number().optional(),
  availableAt: z.string().optional(),
});
export type RetryOutboxBatchInput = z.infer<typeof RetryOutboxBatchInputSchema>;

export const DeleteDeliveredOutboxInputSchema = z.object({
  before: z.string(),
  limit: z.number().optional(),
});
export type DeleteDeliveredOutboxInput = z.infer<typeof DeleteDeliveredOutboxInputSchema>;

// ────────────────────────────── 输出/领域（zod schema + z.infer） ──────────────────────────────

/**
 * event_outbox 对外 DTO。字段与物理列直通、无独立 mapper（outbox-ops 直接返回查询行），
 * 故保留 Row 命名。它是 outbox 聚合的对外表示，不是实现内部细节。
 */
export const OutboxRowSchema = z.object({
  id: z.number(), event_id: z.string(), session_id: z.string(), tenant_id: z.string(), run_id: z.string().nullable(),
  session_seq: z.number(), event_type: z.string(), aggregate_type: z.string(), aggregate_id: z.string(),
  payload: z.string(), status: OutboxStatusSchema, attempts: z.number(), available_at: z.string().nullable(),
  locked_at: z.string().nullable(), delivered_at: z.string().nullable(), last_error: z.string().nullable(),
  created_at: z.string(),
});
export type OutboxRow = z.infer<typeof OutboxRowSchema>;

export const RunInfoSchema = z.object({
  run_id: z.string(),
  session_id: z.string(),
  tenant_id: z.string(),
  entrypoint: z.string().nullable(),
  status: z.string(),
  task_summary: z.string().nullable(),
  terminal_reason: z.string().nullable(),
  request_id: z.string().nullable(),
  user_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  agent_call_id: z.string(),
  lineage_parent_call_id: z.string().nullable(),
  agent_display_name: z.string(),
  lease_root_run_id: z.string(),
  thread_key: z.string(),
  parent_run_id: z.string().nullable(),
  parent_call_id: z.string().nullable(),
  child_agent_id: z.string().nullable(),
  final_message_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type RunInfo = z.infer<typeof RunInfoSchema>;

export const ChildAgentInfoSchema = z.object({
  child_agent_id: z.string(), session_id: z.string(), agent_name: z.string(), thread_key: z.string(), status: z.string(),
  parent_participant_id: z.string().nullable(),
  created_seq: z.number().nullable(), created_by_run_id: z.string().nullable(), created_by_call_id: z.string().nullable(),
  parent_run_id: z.string().nullable(), parent_call_id: z.string().nullable(), last_run_id: z.string().nullable(),
  metadata: z.record(z.unknown()), created_at: z.string(), updated_at: z.string(),
});
export type ChildAgentInfo = z.infer<typeof ChildAgentInfoSchema>;

export const ResourceInfoSchema = z.object({
  resource_id: z.string(), session_id: z.string(), run_id: z.string().nullable(), path: z.string(),
  resource_type: z.string(), sub_type: z.string().nullable(), title: z.string().nullable(), scope: z.string(),
  source_tool: z.string().nullable(),
});
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;

/** 单 agent 的聚合性能指标(对齐前端 AgentMonitor agent 卡片字段)。 */
export const AgentMetricSummarySchema = z.object({
  agent_name: z.string(), total_calls: z.number(), success_count: z.number(), failure_count: z.number(),
  success_rate: z.number(), avg_duration_ms: z.number(), avg_tokens: z.number(), first_call: z.string().nullable(),
  last_call: z.string().nullable(), tool_usage: z.record(z.number()), error_distribution: z.record(z.number()),
});
export type AgentMetricSummary = z.infer<typeof AgentMetricSummarySchema>;

/** token 用量时间序列点(按天或按小时聚合)。 */
export const TokenTrendPointSchema = z.object({ ts: z.string(), token_in: z.number(), token_out: z.number(), calls: z.number() });
export type TokenTrendPoint = z.infer<typeof TokenTrendPointSchema>;

/** 按模型聚合的用量点(model 为 NULL 的历史行归 "未知")。 */
export const ModelUsagePointSchema = z.object({ model: z.string(), tokens: z.number(), calls: z.number() });
export type ModelUsagePoint = z.infer<typeof ModelUsagePointSchema>;

/** 活跃度热力图点:weekday 0-6(0=周日)、hour 0-23。稀疏,前端补全 7×24 网格。 */
export const HeatmapPointSchema = z.object({ weekday: z.number(), hour: z.number(), calls: z.number() });
export type HeatmapPoint = z.infer<typeof HeatmapPointSchema>;

/** 每日活跃度点(GitHub 式日历热力图:date=YYYY-MM-DD)。稀疏,前端按 range 补全。 */
export const DailyActivityPointSchema = z.object({ date: z.string(), calls: z.number() });
export type DailyActivityPoint = z.infer<typeof DailyActivityPointSchema>;

/** addRunStep 返回的精简记录（领域投影，非完整 run_step 物理行）。 */
export const RunStepRecordSchema = z.object({
  id: z.number(),
  run_id: z.string(),
  event_id: z.string().nullable(),
  step_order: z.number(),
  step_type: z.string(),
});
export type RunStepRecord = z.infer<typeof RunStepRecordSchema>;

export const RetryOutboxResultSchema = z.object({ matched: z.number(), retried: z.number(), ids: z.array(z.number()) });
export type RetryOutboxResult = z.infer<typeof RetryOutboxResultSchema>;

export const EventOutboxErrorSummarySchema = z.object({
  id: z.number(), event_id: z.string(), session_id: z.string(), run_id: z.string().nullable(), event_type: z.string(),
  attempts: z.number(), last_error: z.string().nullable(), created_at: z.string(),
});
export type EventOutboxErrorSummary = z.infer<typeof EventOutboxErrorSummarySchema>;

export const EventOutboxStatsSchema = z.object({
  total: z.number(), pending: z.number(), retrying: z.number(), delivered: z.number(), failed: z.number(),
  locked: z.number(), ready: z.number(), oldest_pending_created_at: z.string().nullable(),
  oldest_pending_age_seconds: z.number().nullable(), oldest_retrying_created_at: z.string().nullable(),
  oldest_retrying_age_seconds: z.number().nullable(), oldest_pending_or_retrying_created_at: z.string().nullable(),
  oldest_pending_or_retrying_age_seconds: z.number().nullable(), oldest_failed_created_at: z.string().nullable(),
  oldest_failed_age_seconds: z.number().nullable(), recent_failed_errors: z.array(EventOutboxErrorSummarySchema),
});
export type EventOutboxStats = z.infer<typeof EventOutboxStatsSchema>;
