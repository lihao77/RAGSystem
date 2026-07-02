/**
 * KernelEvent 落库翻译（B1：从 SDK Dispatcher 迁回 backend）。
 *
 * SDK 收窄为纯计算内核后，KernelEvent 的持久化（message/run_step/run 状态）由 backend 独占。
 * 本模块搬运原 SDK Dispatcher 的 event→落库分流逻辑，改用 backend ConversationStore：
 *   - 增量（persist）：intent_complete/tool_call/tool_result/assistant_intermediate/observation_complete
 *     → addRunStep / addMessage；其余事件（first_token/output_delta/intent_delta/error/context_usage）纯遥测不落库。
 *   - 终态（finalize）：一个事务合一落 最终 assistant message + updateRunStepsMessageId + 终态 run_steps
 *     （final + run:end）+ updateRunStatus。interrupted 先 closeDanglingToolCalls 补悬空 tool_result。
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

/** run 级上下文（persister 构造时注入，所有落库动作都挂这上面）。 */
export interface PersisterRunContext {
  sessionId: string;
  runId: string;
  threadKey: string;
  agentName: string;
  agentDisplayName: string;
  /** 当前 run 的 root call id（step_id 规则基准；root run=自身 call_id，child run=父 call_id）。 */
  rootCallId: string;
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
      ...(this.ctx.userId !== undefined ? { userId: this.ctx.userId } : {}),
      ...(this.ctx.parentRunId !== undefined ? { parentRunId: this.ctx.parentRunId } : {}),
      ...(this.ctx.parentCallId !== undefined ? { parentCallId: this.ctx.parentCallId } : {}),
      ...(this.ctx.childAgentId !== undefined ? { childAgentId: this.ctx.childAgentId } : {}),
    });
  }

  /** 增量落库（KernelEvent → message/run_step）。纯遥测事件不落库。 */
  persist(event: KernelEvent): void {
    switch (event.type) {
      case "intent_complete":
        this.persistIntentComplete(event);
        break;
      case "tool_call":
        this.persistToolStep(event, "start");
        break;
      case "tool_result":
        this.persistToolStep(event, "end");
        break;
      case "assistant_intermediate":
        this.persistAssistantMessage(event.message, event.round);
        break;
      case "observation_complete":
        this.persistObservations(event.messages, event.round);
        break;
      default:
        break;
    }
  }

  /**
   * run 终态收口（一个事务合一）：
   * - completed：落最终 assistant message + updateRunStepsMessageId + 终态 steps + updateRunStatus。
   * - interrupted：closeDanglingToolCalls 补悬空 tool_result + 落空 assistant anchor + 终态 steps + updateRunStatus。
   * - failed：仅终态 steps + updateRunStatus（无 final message）。
   */
  finalize(status: "completed" | "failed" | "interrupted", finalMessage: FinalMessageInput | null): void {
    this.store.runInTransaction((tx) => {
      let finalMessageId: string | null = null;
      if (status === "interrupted") {
        this.closeDanglingToolCalls(tx);
        const anchor = tx.addMessage({
          sessionId: this.ctx.sessionId,
          role: "assistant",
          content: "",
          threadKey: this.ctx.threadKey,
          metadata: { ...this.finalMessageMeta(), msg_type: "assistant_final", interrupted: true },
        });
        tx.updateRunStepsMessageId(this.ctx.sessionId, this.ctx.runId, anchor.id);
        finalMessageId = anchor.id;
      } else if (status === "completed" && finalMessage) {
        const msg = tx.addMessage({
          sessionId: this.ctx.sessionId,
          role: "assistant",
          content: finalMessage.content,
          threadKey: this.ctx.threadKey,
          // finalMessageMeta（agent/team/scope/execution_kind）打底，调用点 messageMetadata（retry_of_*）盖之，finalMessage 自带 metadata 优先。
          metadata: {
            ...this.finalMessageMeta(),
            msg_type: "assistant_final",
            ...(this.ctx.messageMetadata ?? {}),
            ...(finalMessage.metadata ?? {}),
          },
          ...(finalMessage.id ? { messageId: finalMessage.id } : {}),
        });
        tx.updateRunStepsMessageId(this.ctx.sessionId, this.ctx.runId, msg.id);
        finalMessageId = msg.id;
      }
      this.persistTerminalSteps(tx, status, finalMessageId, finalMessage?.content ?? "");
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

  private persistIntentComplete(event: KernelEvent & { type: "intent_complete" }): void {
    this.store.runInTransaction((tx) => {
      tx.addRunStep({
        sessionId: this.ctx.sessionId,
        runId: this.ctx.runId,
        stepType: "execution.step",
        payload: {
          kind: "intent",
          phase: "complete",
          call_id: this.ctx.rootCallId,
          parent_call_id: this.ctx.parentCallId,
          step_id: `${this.ctx.rootCallId}:round:${event.round}`,
          parent_step_id: `${this.ctx.rootCallId}:run`,
          agent_name: event.agentName,
          agent_display_name: this.ctx.agentDisplayName,
          content: event.content,
          round: event.round,
          status: "completed",
          ...this.stepMarkers(),
        },
      });
    });
  }

  private persistToolStep(event: KernelEvent & { type: "tool_call" | "tool_result" }, phase: "start" | "end"): void {
    this.store.runInTransaction((tx) => {
      tx.addRunStep({
        sessionId: this.ctx.sessionId,
        runId: this.ctx.runId,
        stepType: "execution.step",
        payload: this.buildToolStepPayload(event, phase),
      });
    });
  }

  /** tool run_step payload（对齐 execution.step 契约：step_id/parent_step_id/display_name/task_id/request_id/status）。 */
  private buildToolStepPayload(event: KernelEvent & { type: "tool_call" | "tool_result" }, phase: "start" | "end"): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      kind: "tool",
      phase,
      step_id: `${event.toolCallId}:tool`,
      parent_step_id: `${this.ctx.rootCallId}:round:${event.round}`,
      agent_name: event.agentName,
      agent_display_name: this.ctx.agentDisplayName,
      tool_name: event.toolName,
      call_id: event.toolCallId,
      tool_call_id: event.toolCallId,
      parent_call_id: this.ctx.rootCallId,
      round: event.round,
      order: event.order,
      round_index: event.roundIndex,
      status: phase === "start" ? "running" : event.type === "tool_result" && event.success ? "success" : "error",
      ...this.stepMarkers(),
    };
    if (event.type === "tool_call") {
      payload.arguments = event.arguments;
    } else {
      payload.success = event.success;
      payload.summary = event.summary;
      payload.observation = event.observation;
      payload.result_preview = event.observation || event.summary;
      payload.elapsed_time = event.elapsedTime;
    }
    return payload;
  }

  private persistAssistantMessage(message: ChatMessage, round: number): void {
    this.store.runInTransaction((tx) => {
      const input: AddMessageInput = {
        sessionId: this.ctx.sessionId,
        role: "assistant",
        content: extractText(message.content),
        threadKey: this.ctx.threadKey,
        metadata: { ...this.messageMeta(round), msg_type: "intent" },
      };
      if (message.tool_calls) {
        input.toolCalls = message.tool_calls as AddMessageInput["toolCalls"];
      }
      tx.addMessage(input);
    });
  }

  private persistObservations(messages: readonly ChatMessage[], round: number): void {
    this.store.runInTransaction((tx) => {
      for (const message of messages) {
        const input: AddMessageInput = {
          sessionId: this.ctx.sessionId,
          role: "tool",
          content: extractText(message.content),
          threadKey: this.ctx.threadKey,
          metadata: { ...this.messageMeta(round), msg_type: "observation" },
        };
        if (message.tool_call_id) {
          input.toolCallId = message.tool_call_id;
        }
        if (message.name) {
          input.name = message.name;
        }
        tx.addMessage(input);
      }
    });
  }

  // ────────────────────────────── 终态 steps ──────────────────────────────

  /**
   * 终态 run_step：completed 落 final + run:end；failed/interrupted 仅落 run:end。
   * 对齐 buildFinalStepPayload / buildRunEndStepPayload 契约（step_id/parent_step_id/display_name/task_id/request_id/status/result_preview）。
   */
  private persistTerminalSteps(
    tx: ConversationStoreTransaction,
    status: "completed" | "failed" | "interrupted",
    finalMessageId: string | null,
    finalContent: string,
  ): void {
    const resultPreview = finalContent.slice(0, 500);
    if (status === "completed") {
      tx.addRunStep({
        sessionId: this.ctx.sessionId,
        runId: this.ctx.runId,
        stepType: "execution.step",
        payload: {
          kind: "final",
          phase: "complete",
          call_id: this.ctx.rootCallId,
          parent_call_id: null,
          step_id: `${this.ctx.rootCallId}:final`,
          parent_step_id: `${this.ctx.rootCallId}:run`,
          agent_name: this.ctx.agentName,
          agent_display_name: this.ctx.agentDisplayName,
          message_id: finalMessageId ?? "",
          status: "completed",
          result_preview: resultPreview,
          ...this.stepMarkers(),
        },
      });
    }
    const runEndPayload: Record<string, unknown> = {
      kind: "run",
      phase: "end",
      call_id: this.ctx.rootCallId,
      parent_call_id: null,
      step_id: `${this.ctx.rootCallId}:run`,
      parent_step_id: null,
      agent_name: this.ctx.agentName,
      agent_display_name: this.ctx.agentDisplayName,
      status,
      ...this.stepMarkers(),
    };
    if (status === "completed") {
      runEndPayload.result_preview = resultPreview;
    } else if (status === "interrupted") {
      runEndPayload.result_preview = "[已停止生成]";
    }
    tx.addRunStep({
      sessionId: this.ctx.sessionId,
      runId: this.ctx.runId,
      stepType: "execution.step",
      payload: runEndPayload,
    });
  }

  // ────────────────────────────── interrupted 悬空收口 ──────────────────────────────

  /** 扫历史补配对 tool_result：本 run 未应答的 assistant tool_use 补 interrupted observation（终态事务内）。 */
  private closeDanglingToolCalls(tx: ConversationStoreTransaction): void {
    const recent = this.store.getRecentMessages(this.ctx.sessionId, 1000, this.ctx.threadKey);
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
      let order = 1;
      for (const toolCall of message.tool_calls) {
        if (answered.has(toolCall.id)) {
          order += 1;
          continue;
        }
        tx.addMessage({
          sessionId: this.ctx.sessionId,
          role: "tool",
          content: INTERRUPTED_OBSERVATION,
          toolCallId: toolCall.id,
          name: toolCall.function.name,
          threadKey: this.ctx.threadKey,
          metadata: { interrupted: true, agent_name: this.ctx.agentName, run_id: this.ctx.runId, round: round + 1, msg_type: "observation" },
        });
        tx.addRunStep({
          sessionId: this.ctx.sessionId,
          runId: this.ctx.runId,
          stepType: "execution.step",
          payload: { kind: "tool", phase: "end", tool_name: toolCall.function.name, call_id: toolCall.id, round, order, success: false, observation: INTERRUPTED_OBSERVATION, summary: INTERRUPTED_SUMMARY, agent_name: this.ctx.agentName, run_id: this.ctx.runId },
        });
        order += 1;
      }
    }
  }

  // ────────────────────────────── metadata / markers ──────────────────────────────

  /** run_step payload 公共字段（run_id/task_id/request_id；按可用性展开）。 */
  private stepMarkers(): Record<string, unknown> {
    const markers: Record<string, unknown> = { run_id: this.ctx.runId };
    if (this.ctx.taskId) {
      markers.task_id = this.ctx.taskId;
    }
    if (this.ctx.requestId) {
      markers.request_id = this.ctx.requestId;
    }
    return markers;
  }

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
const INTERRUPTED_SUMMARY = "工具执行被中断";

function resolveRound(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value - 1) : 0;
}
