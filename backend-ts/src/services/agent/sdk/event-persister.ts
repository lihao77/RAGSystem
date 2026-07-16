/**
 * KernelEvent 落库翻译（B1：从 SDK Dispatcher 迁回 backend）。
 *
 * SDK 收窄为纯计算内核后，message/run 状态持久化由 backend 独占；执行历史 Envelope
 * 由 DurableClientEventPublisher 统一归档，本模块不再写 run_steps。
 *   - 增量（persist）：tool_result 落 observation message，assistant_intermediate 落消息。
 *   - 终态（finalize）：一个事务合一落最终 assistant message + 关联已归档 Envelope + updateRunStatus。
 *     interrupted 时补悬空工具的 observation message。
 *   - startRun：createRun（backend 独占，SDK 不再 createRun）。
 *
 * 与原 SDK Dispatcher 的差异：
 *   - updateRunStatus 在事务内（ConversationStoreTransaction 自带），终态全合一，比 SDK 事务外更原子。
 *   - listMessages → getRecentMessages；扫悬空的 MessageInfo 用蛇形字段（tool_calls/tool_call_id）。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";
import type { KernelEvent } from "@ragsystem/agent-sdk";
import type {
  ConversationStore,
  ConversationStoreTransaction,
} from "../../../contracts/conversation-store/index.js";
import type { AddMessageInput } from "../../../contracts/conversation-store/types.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";

/** run 级上下文（persister 构造时注入，所有落库动作都挂这上面）。 */
export interface PersisterRunContext {
  sessionId: string;
  runId: string;
  threadKey: string;
  agentName: string;
  agentDisplayName: string;
  /** 当前 run 的 root call id（step_id 规则基准；root run=自身 call_id，child run=父 call_id）。 */
  rootCallId: string;
  /** 整棵执行树的根 run id；挂起时与 pending interaction 同事务收口。 */
  rootRunId?: string;
  /** 父 run 的 call_id（root run=null；用于 lineage / conversation_scope 判定）。 */
  parentCallId: string | null;
  taskId?: string | null;
  requestId?: string | null;
  /** run 入口标识（executionKind）；落 message metadata.execution_kind + runs.entrypoint。 */
  executionKind?: string;
  /** 任务摘要（task 前 200 字），落 runs.task_summary。 */
  taskSummary?: string;
  userId?: string | null;
  /**
   * run 级附加消息元数据（合并到最终 assistant 消息 metadata）。
   * 消费端据此把 retry_of_* 等调用点元数据打到最终消息上（无值不影响默认）。
   */
  messageMetadata?: Record<string, unknown> | null;
  /** 父 run id（child delegation run 用；root run 不传）。 */
  parentRunId?: string | null;
  /** child agent id（child delegation run 用；root run 不传）。 */
  childAgentId?: string | null;
}

export interface FinalMessageInput {
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export class KernelEventPersister {
  constructor(
    private readonly store: ConversationStore,
    private readonly ctx: PersisterRunContext,
  ) {}

  /** run 起始：createRun（backend 独占）。 */
  startRun(): void {
    this.store.createRun({
      runId: this.ctx.runId,
      sessionId: this.ctx.sessionId,
      status: "running",
      agentName: this.ctx.agentName,
      threadKey: this.ctx.threadKey,
      ...(this.ctx.executionKind !== undefined ? { entrypoint: this.ctx.executionKind } : {}),
      ...(this.ctx.taskSummary !== undefined ? { taskSummary: this.ctx.taskSummary } : {}),
      ...(this.ctx.requestId !== undefined ? { requestId: this.ctx.requestId } : {}),
      ...(this.ctx.userId !== undefined ? { userId: this.ctx.userId } : {}),
      ...(this.ctx.parentRunId !== undefined ? { parentRunId: this.ctx.parentRunId } : {}),
      ...(this.ctx.parentCallId !== undefined ? { parentCallId: this.ctx.parentCallId } : {}),
      ...(this.ctx.childAgentId !== undefined ? { childAgentId: this.ctx.childAgentId } : {}),
    });
  }

  /** 增量消息落库；执行 Envelope 由发布器独立归档。 */
  persist(event: KernelEvent): void {
    switch (event.type) {
      case "tool_result":
        this.persistToolResultMessage(event);
        break;
      case "assistant_intermediate":
        this.persistAssistantMessage(event.message, event.round);
        break;
      default:
        break;
    }
  }

  /**
   * run 终态收口（一个事务合一）：
   * - completed：落最终 assistant message + 关联 Envelope + updateRunStatus。
   * - interrupted：补悬空 observation + 落空 assistant anchor + updateRunStatus。
   * - suspended：仅 updateRunStatus，保留悬空 tool_use 供恢复时重执行。
   * - failed：仅 updateRunStatus（无 final message）。
   */
  finalize(status: "completed" | "failed" | "interrupted" | "suspended", finalMessage: FinalMessageInput | null): void {
    this.store.runInTransaction((tx) => {
      if (status === "suspended") {
        tx.suspendPendingInteractions(this.ctx.sessionId, this.ctx.rootRunId ?? this.ctx.runId);
        tx.updateRunStatus(this.ctx.runId, this.ctx.sessionId, "suspended", null);
        return;
      }
      let finalMessageId: string | null = null;
      if (status === "interrupted") {
        this.closeDanglingToolCalls(tx);
        const anchor = tx.addMessage({
          sessionId: this.ctx.sessionId,
          role: "assistant",
          content: "",
          threadKey: this.ctx.threadKey,
          metadata: { ...this.finalMessageMeta(), msg_type: MSG_TYPE.ASSISTANT_FINAL, interrupted: true },
        });
        tx.updateRunStepsMessageId(this.ctx.sessionId, this.ctx.runId, anchor.id);
        finalMessageId = anchor.id;
      } else if (status === "completed" && finalMessage) {
        // caller（runtime-adapter.executeRunWithSdk）completed 时恒传非空 finalMessage（{ content: result.content }），
        // 本分支必命中、最终 message 必落。若未来 caller 传 null（未使用边界），将跳过落 message、落空 final step
        // （message_id/result_preview 空）—— 该边界需 caller 保证不触发。
        const msg = tx.addMessage({
          sessionId: this.ctx.sessionId,
          role: "assistant",
          content: finalMessage.content,
          threadKey: this.ctx.threadKey,
          // finalMessageMeta（agent/team/scope/execution_kind）打底，调用点 messageMetadata（retry_of_*）盖之，finalMessage 自带 metadata 优先。
          metadata: {
            ...this.finalMessageMeta(),
            msg_type: MSG_TYPE.ASSISTANT_FINAL,
            ...(this.ctx.messageMetadata ?? {}),
            ...(finalMessage.metadata ?? {}),
          },
          ...(finalMessage.id ? { messageId: finalMessage.id } : {}),
        });
        tx.updateRunStepsMessageId(this.ctx.sessionId, this.ctx.runId, msg.id);
        finalMessageId = msg.id;
      }
      tx.updateRunStatus(this.ctx.runId, this.ctx.sessionId, status, finalMessageId);
    });
  }

  /** 查询本 run 的最终 assistant 消息（runs.final_message_id → messages；completed 终态后可查）。 */
  resolveFinalMessage(): { id: string; seq: number; content: string } | null {
    const run = this.store.getRun(this.ctx.sessionId, this.ctx.runId);
    if (!run || !run.final_message_id) {
      return null;
    }
    const msg = this.store.getMessageById(this.ctx.sessionId, run.final_message_id);
    if (!msg) {
      return null;
    }
    return { id: msg.id, seq: msg.seq, content: msg.content };
  }

  // ────────────────────────────── 增量落库 ──────────────────────────────

  private persistToolResultMessage(event: KernelEvent & { type: "tool_result" }): void {
    const toolMedia = Array.isArray(event.metadata.tool_result_media) ? event.metadata.tool_result_media : [];
    this.store.runInTransaction((tx) => {
      tx.addMessage({
        sessionId: this.ctx.sessionId,
        role: "tool",
        content: event.observation,
        threadKey: this.ctx.threadKey,
        metadata: {
          ...this.messageMeta(event.round),
          msg_type: MSG_TYPE.OBSERVATION,
          ...(toolMedia.length ? { extensions: [{ kind: "tool_result_media", data: { media: toolMedia } }] } : {}),
        },
        toolCallId: event.toolCallId,
        name: event.toolName,
      });
    });
  }

  private persistAssistantMessage(message: ChatMessage, round: number): void {
    this.store.runInTransaction((tx) => {
      const input: AddMessageInput = {
        sessionId: this.ctx.sessionId,
        role: "assistant",
        content: extractText(message.content),
        threadKey: this.ctx.threadKey,
        metadata: { ...this.messageMeta(round), msg_type: MSG_TYPE.INTENT },
      };
      if (message.tool_calls) {
        input.toolCalls = message.tool_calls as AddMessageInput["toolCalls"];
      }
      tx.addMessage(input);
    });
  }

  // ────────────────────────────── interrupted 悬空收口 ──────────────────────────────

  /** 扫历史补配对 tool_result：本 run 未应答的 assistant tool_use 补 interrupted observation（终态事务内）。 */
  private closeDanglingToolCalls(tx: ConversationStoreTransaction): void {
    const recent = tx.getRecentMessages(this.ctx.sessionId, 1000, this.ctx.threadKey);
    const answered = new Set<string>();
    for (const message of recent) {
      if (message.role === "tool" && message.tool_call_id) {
        answered.add(message.tool_call_id);
      }
    }
    for (const message of recent) {
      if (message.role !== "assistant" || !message.tool_calls || message.tool_calls.length === 0) {
        continue;
      }
      if (message.metadata.run_id !== this.ctx.runId) {
        continue;
      }
      const round = resolveRound(message.metadata.round);
      for (const toolCall of message.tool_calls) {
        if (answered.has(toolCall.id)) {
          continue;
        }
        tx.addMessage({
          sessionId: this.ctx.sessionId,
          role: "tool",
          content: INTERRUPTED_OBSERVATION,
          toolCallId: toolCall.id,
          name: toolCall.function.name,
          threadKey: this.ctx.threadKey,
          metadata: { interrupted: true, agent_name: this.ctx.agentName, run_id: this.ctx.runId, round: round + 1, msg_type: MSG_TYPE.OBSERVATION },
        });
      }
    }
  }

  // ────────────────────────────── metadata / markers ──────────────────────────────

  /** 中间 message 公共 metadata（react_intermediate + run/task/request/agent/thread/scope/visible/execution_kind）。 */
  private messageMeta(round: number): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      agent_name: this.ctx.agentName,
      run_id: this.ctx.runId,
      agent: this.ctx.agentName,
      thread_key: this.ctx.threadKey,
      conversation_scope: this.ctx.parentCallId !== null ? "child" : "root",
      react_intermediate: true,
      visible_to_user: true,
      round: round + 1,
    };
    if (this.ctx.taskId) {
      meta.task_id = this.ctx.taskId;
    }
    if (this.ctx.requestId) {
      meta.request_id = this.ctx.requestId;
    }
    if (this.ctx.executionKind) {
      meta.execution_kind = this.ctx.executionKind;
    }
    return meta;
  }

  /** 最终 assistant 消息 metadata（非 react_intermediate；agent/thread/scope + 可选 task/request/execution_kind）。 */
  private finalMessageMeta(): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      agent_name: this.ctx.agentName,
      run_id: this.ctx.runId,
      agent: this.ctx.agentName,
      thread_key: this.ctx.threadKey,
      conversation_scope: this.ctx.parentCallId !== null ? "child" : "root",
    };
    if (this.ctx.taskId) {
      meta.task_id = this.ctx.taskId;
    }
    if (this.ctx.requestId) {
      meta.request_id = this.ctx.requestId;
    }
    if (this.ctx.executionKind) {
      meta.execution_kind = this.ctx.executionKind;
    }
    return meta;
  }
}

const INTERRUPTED_OBSERVATION = "工具执行被中断";
function resolveRound(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value - 1) : 0;
}
