/**
 * conversation-store 数据契约（身份证的数据面）。
 *
 * 分层原则：
 * - 输入边界（*Input）用 zod schema 定义 → z.infer 产出类型，既给编译期类型，
 *   也给运行时入口校验（见 ops 边界 parse）。schema 字段与历史 interface 逐一对应，
 *   不收紧历史数据（metadata/payload 用 z.record(z.unknown()) 宽松，避免拒历史行）。
 * - 输出/领域（*Info/*Row/Result/Stats）暂用 interface（输出 zod 化留 TODO）。
 *
 * 契约独立：本文件只 import contracts/ 内其他文件（session），绝不 import services/。
 * 凡 IXxxStore 签名引用的类型必在此定义——否则契约反向依赖实现，破坏可替换性。
 */
import { z } from "zod";

import type { MessageInfo } from "../session.js";

// ────────────────────────────── 共享枚举 ──────────────────────────────

export const OutboxStatusSchema = z.enum(["pending", "retrying", "delivered", "failed"]);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

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
  metadata: z.record(z.unknown()).optional(),
  toolCalls: z.array(MessageToolCallSchema).optional(),
  toolCallId: z.string().optional(),
  name: z.string().optional(),
  messageId: z.string().optional(),
  threadKey: z.string().optional(),
  childAgentId: z.string().nullable().optional(),
});
export type AddMessageInput = z.infer<typeof AddMessageInputSchema>;

export const AddRunStepInputSchema = z.object({
  sessionId: z.string(),
  runId: z.string(),
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

// ────────────────────────────── 输出/领域（interface） ──────────────────────────────

/**
 * event_outbox 对外 DTO。字段与物理列直通、无独立 mapper（outbox-ops 直接返回查询行），
 * 故保留 Row 命名。它是 outbox 聚合的对外表示，不是实现内部细节。
 */
export interface OutboxRow {
  id: number;
  event_id: string;
  session_id: string;
  run_id: string | null;
  session_seq: number;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  available_at: string | null;
  locked_at: string | null;
  delivered_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface RunInfo {
  run_id: string;
  session_id: string;
  entrypoint: string | null;
  status: string;
  task_summary: string | null;
  user_id: string | null;
  agent_name: string | null;
  thread_key: string;
  parent_run_id: string | null;
  parent_call_id: string | null;
  child_agent_id: string | null;
  final_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChildAgentInfo {
  child_agent_id: string;
  session_id: string;
  agent_name: string;
  thread_key: string;
  status: string;
  created_seq: number | null;
  created_by_run_id: string | null;
  created_by_call_id: string | null;
  parent_run_id: string | null;
  parent_call_id: string | null;
  last_run_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ResourceInfo {
  resource_id: string;
  session_id: string;
  run_id: string | null;
  path: string;
  resource_type: string;
  sub_type: string | null;
  title: string | null;
  scope: string;
  source_tool: string | null;
}

/** 单 agent 的聚合性能指标(对齐前端 AgentMonitor agent 卡片字段)。 */
export interface AgentMetricSummary {
  agent_name: string;
  total_calls: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration_ms: number;
  avg_tokens: number;
  first_call: string | null;
  last_call: string | null;
  tool_usage: Record<string, number>;
  error_distribution: Record<string, number>;
}

/** addRunStep 返回的精简记录（领域投影，非完整 run_step 物理行）。 */
export interface RunStepRecord {
  id: number;
  run_id: string;
  step_order: number;
  step_type: string;
}

export interface RetryOutboxResult {
  matched: number;
  retried: number;
  ids: number[];
}

export interface EventOutboxErrorSummary {
  id: number;
  event_id: string;
  session_id: string;
  run_id: string | null;
  event_type: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface EventOutboxStats {
  total: number;
  pending: number;
  retrying: number;
  delivered: number;
  failed: number;
  locked: number;
  ready: number;
  oldest_pending_created_at: string | null;
  oldest_pending_age_seconds: number | null;
  oldest_retrying_created_at: string | null;
  oldest_retrying_age_seconds: number | null;
  oldest_pending_or_retrying_created_at: string | null;
  oldest_pending_or_retrying_age_seconds: number | null;
  oldest_failed_created_at: string | null;
  oldest_failed_age_seconds: number | null;
  recent_failed_errors: EventOutboxErrorSummary[];
}

export interface ConversationStoreOptions {
  dbPath: string;
  dataRoot?: string | undefined;
}

// ────────────────────────────── 行为契约：跨域事务 ──────────────────────────────

/**
 * 事务内协调面：runInTransaction 的 operation 回调参数。
 *
 * 深合约——原子性：同一 runInTransaction 内对 message/run/outbox 的多次写入，
 * 全部在同一 SQLite 事务提交，要么全部成功要么全部回滚（见 shared/transaction.ts）。
 * 这是「最终消息 + 步骤归档 + outbox 投递」三者一致的语义前提。
 *
 * 读亦走事务内：终态收口存在「先读历史再据之写入」的形态（如 interrupted 补悬空
 * tool_result），读与写必须同一事务，否则读在事务外有 TOCTOU 窗口——并发 session
 * 写入可在读后写前插入消息，令扫描结果与实际写入失配。
 */
export interface ConversationStoreTransaction {
  addMessage(input: AddMessageInput): MessageInfo;
  addRunStep(input: AddRunStepInput): RunStepRecord;
  updateRunStepsMessageId(sessionId: string, runId: string, messageId: string): number;
  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId?: string | null): boolean;
  nextSessionSeq(sessionId: string): number;
  appendOutbox(input: AppendOutboxInput): OutboxRow;
  /** 读最近消息（对齐 IMessageStore.getRecentMessages：纯 SELECT 不开新事务，事务内读消除 TOCTOU）。 */
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[];
}
