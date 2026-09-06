import type { MessageContentPart } from "@ragsystem/agent-protocol";

/** Durable message kinds exchanged by agents while an invocation is alive. */
export type AgentMailboxMessageKind =
  | "progress"
  | "request"
  | "response"
  | "result";

/**
 * 队列行的三种生命周期（input_type 标记"信封内容是什么"，不代表该行必然经历
 * 排队语义）：
 * - 等待行：入队后驻留为 queued，等认领消费（运行中由活动 run 的 refresh、空闲/
 *   唤醒由 SessionMailboxConsumer）——排队的用户 followup、运行中到达的后台通知、
 *   agent 间消息、续跑结果、goal 续跑（goal 生产者在预算门控
 *   GoalStore.claimContinuation 通过后投递，投递成功即释放认领，循环由队列串行化：
 *   行被消费才起 run，run 终态才触发下一轮投递）；
 * - 过路行：同事务 enqueue+settle，落库即 acked，只作审计留痕与会话消息行的派生
 *   源——用户首发（startOrAppendRoot）、slash 命令 echo 行与 idle 批量消费的伴随行
 *   （appendMailboxMessage，无 run）；
 * - 引用行：先作为等待行入队，后被认领为某 run 的初始输入，起 run 事务内 settle
 *   ——session_followup、mailbox 续跑、通知/goal 的 idle 消费（认领行直接作为
 *   初始消息，不合成第二条随机 id 行）。
 *
 * 重投有界（防热循环）：claim 前把 attempt_count 达 AGENT_MAILBOX_MAX_DELIVERY_ATTEMPTS
 * 的 queued 行置 expired（死信，last_error 标注原因）；消费失败 release 按
 * mailboxRetryBackoffMs 指数退避。goal 的循环保护由两层共同承担——GoalStore 预算
 * 门控生产节奏，队列死信封顶单行重投。
 */

/** 单行投递尝试上限：达到后 claim 前置为 expired（死信），重投有界。 */
export const AGENT_MAILBOX_MAX_DELIVERY_ATTEMPTS = 20;

/** 消费失败退避：按已尝试次数指数增长（5s 起、翻倍、封顶 5 分钟）。 */
export function mailboxRetryBackoffMs(attemptCount: number): number {
  const attempt = Math.max(1, Math.floor(attemptCount));
  return Math.min(5_000 * 2 ** (attempt - 1), 300_000);
}
export type AgentMailboxInputType =
  | "user_message"
  | "agent_message"
  | "system_notification"
  | "goal_continuation";

export type AgentMailboxSourceKind = "user" | "agent" | "system";

export type AgentMailboxMessageStatus =
  | "queued"
  | "claimed"
  | "acked"
  | "expired";

export interface AgentMailboxMessage {
  seq: number;
  message_id: string;
  tenant_id: string;
  session_id: string;
  source_run_id: string | null;
  source_agent_call_id: string | null;
  /** 溯源审计字段：写入方记录投递时的执行上下文，认领/唤醒一律不按此匹配（§10.4 第七轮）。 */
  target_run_id: string | null;
  target_agent_call_id: string | null;
  target_thread_key: string;
  target_child_agent_id: string | null;
  kind: AgentMailboxMessageKind;
  input_type: AgentMailboxInputType;
  source_kind: AgentMailboxSourceKind;
  visible_to_user: boolean;
  sent_at: string | null;
  correlation_id: string | null;
  reply_to_message_id: string | null;
  content_parts: MessageContentPart[];
  metadata: Record<string, unknown>;
  status: AgentMailboxMessageStatus;
  attempt_count: number;
  claim_id: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  available_at: string;
  expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  acked_at: string | null;
}

export interface EnqueueAgentMailboxMessageInput {
  messageId: string;
  tenantId: string;
  sessionId: string;
  sourceRunId?: string | null;
  sourceAgentCallId?: string | null;
  targetRunId?: string | null;
  targetAgentCallId?: string | null;
  targetThreadKey: string;
  targetChildAgentId?: string | null;
  kind: AgentMailboxMessageKind;
  inputType?: AgentMailboxInputType;
  sourceKind?: AgentMailboxSourceKind;
  visibleToUser?: boolean;
  sentAt?: string | null;
  correlationId?: string | null;
  replyToMessageId?: string | null;
  contentParts?: MessageContentPart[];
  metadata?: Record<string, unknown>;
  availableAt?: string;
  expiresAt?: string | null;
}

export interface ClaimAgentMailboxInput {
  sessionId: string;
  /** 认领口径=纯线程（§10.4 第七轮）：只按分支匹配，不看行上的溯源 run 字段。 */
  targetThreadKey: string;
  targetChildAgentId?: string | null;
  claimId: string;
  consumerId: string;
  leaseMs?: number;
  limit?: number;
  now?: string;
}

export interface AckAgentMailboxInput {
  sessionId: string;
  messageId: string;
  claimId: string;
}

export interface ReleaseAgentMailboxInput {
  sessionId: string;
  messageId: string;
  claimId: string;
  availableAt?: string;
  lastError?: string | null;
}

export interface SettleAgentMailboxInput {
  sessionId: string;
  messageId: string;
}

export interface ListPendingAgentMailboxInput {
  sessionId: string;
  targetThreadKey?: string | null;
  targetChildAgentId?: string | null;
  limit?: number;
  now?: string;
}

/** 触发闭环兜底扫描：列出仍有可认领 queued 行的会话（崩溃恢复后无事件源的滞留行）。 */
export interface ListPendingMailboxSessionsInput {
  limit?: number;
  now?: string;
}

/**
 * 指定形状的在途行存在性（status IN queued/claimed，含退避中的行）。goal 生产
 * 防重复投递等全量判定用——不受 listPending 的 100 行认领窗口限制（root 分支
 * 积压超窗时 FIFO 头 100 条可能看不到最新投递的 goal 行）。claimed 行计入：
 * 行正在被消费时不应再生产下一代（该 run 终态会触发下一轮生产）。
 */
export interface ExistsPendingAgentMailboxInput {
  sessionId: string;
  inputType?: AgentMailboxInputType;
  targetThreadKey?: string | null;
}

/**
 * 收件人唤醒目标（纯线程寻址，§10.4 第七轮）：唤醒=无状态调用该线程的闸门，
 * 不携带也不比较任何 run 级字段；闸门认领该线程 FIFO 头行作为初始输入。
 * 并发重复触发由闸门事务（认领互斥）分出胜负。
 */
export interface AgentMailboxWakeupTarget {
  sessionId: string;
  targetThreadKey: string;
  targetChildAgentId: string | null;
}

/**
 * Promise-only durable mailbox port. Implementations must fence every state
 * transition with claimId so a worker whose lease expired cannot ACK a newer
 * claim. `claim` is FIFO and atomically requeues expired claims before picking
 * new messages.
 */
export interface AgentMailboxStorePort {
  enqueue(input: EnqueueAgentMailboxMessageInput): Promise<AgentMailboxMessage>;
  get(sessionId: string, messageId: string): Promise<AgentMailboxMessage | null>;
  /** Read queued messages for restart/idle wakeup orchestration. */
  listPending?(input: ListPendingAgentMailboxInput): Promise<AgentMailboxMessage[]>;
  /** Sessions that still have claimable queued rows, for the liveness sweep. */
  listPendingSessions?(input?: ListPendingMailboxSessionsInput): Promise<string[]>;
  /** 指定形状在途行（queued/claimed）的全量存在性，不受 listPending 认领窗口限制。 */
  existsPending?(input: ExistsPendingAgentMailboxInput): Promise<boolean>;
  claim(input: ClaimAgentMailboxInput): Promise<AgentMailboxMessage[]>;
  ack(input: AckAgentMailboxInput): Promise<boolean>;
  /**
   * Terminal recovery only: prevent a durably finalized continuation source
   * from being retried. Also suppresses a background notification whose
   * result was already returned inline to a polling run (idempotent on
   * missing rows: returns false without inserting).
   */
  settle(input: SettleAgentMailboxInput): Promise<boolean>;
  release(input: ReleaseAgentMailboxInput): Promise<boolean>;
  expire(input?: { sessionId?: string; now?: string }): Promise<number>;
}
