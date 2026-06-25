/**
 * Dispatcher —— 统一消费点（设计稿 §6）。
 *
 * 职责（三件解耦）：
 * 1. 落库：收 KernelEvent → 按 §6 分流表在 tx 内落 message/run_step（SDK 自维护原子性）。
 * 2. 推流：把**原始 KernelEvent** 推进 handle.events 队列——所有事件一律推，不分流。
 * 3. 悬空收口：interrupted 时扫历史补配对 tool_result（终态 tx 内）。
 *
 * 不翻译：翻译成 Envelope/可视化是消费端（backend-ts）的事（§6 原则 4）。
 * 实现 EventSink：注入内核，内核 emit → 本类落库 + 推流。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { EventSink, KernelEvent, RuntimeStore, RuntimeTx } from "./contracts.js";
import { AsyncQueue } from "./async-queue.js";

/** run 级上下文（dispatcher 构造时注入，所有落库动作都挂这上面）。 */
export interface DispatcherRunContext {
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
  executionKind?: string | null;
  /** 任务摘要 / 用户（透传 createRun，落 runs 表；可选）。 */
  taskSummary?: string | null;
  userId?: string | null;
  /**
   * run 级附加消息元数据（透传给 finalize，合并到最终 assistant 消息 metadata）。
   * 消费端据此把 retry_of_* 等调用点元数据打到最终消息上（无值不影响默认）。
   */
  messageMetadata?: Record<string, unknown> | null;
}

export class Dispatcher implements EventSink {
  readonly events = new AsyncQueue<KernelEvent>();

  constructor(
    private readonly store: RuntimeStore,
    private readonly ctx: DispatcherRunContext,
  ) {}

  emit(event: KernelEvent): void {
    this.persist(event);
    this.events.push(event);
  }

  /** run 起始：createRun。 */
 startRun(): void {
  this.store.createRun({
    id: this.ctx.runId,
    sessionId: this.ctx.sessionId,
    rootCallId: this.ctx.rootCallId,
    threadKey: this.ctx.threadKey,
    parentCallId: this.ctx.parentCallId,
     ...(this.ctx.executionKind !== undefined ? { entrypoint: this.ctx.executionKind } : {}),
     ...(this.ctx.taskSummary !== undefined ? { taskSummary: this.ctx.taskSummary } : {}),
     ...(this.ctx.userId !== undefined ? { userId: this.ctx.userId } : {}),
  });
 }

  /**
   * run 终态收口。completed：落最终 assistant 消息 + run_step + updateRunStatus。
   * interrupted：扫悬空 tool_use 补 tool_result（终态 tx 内）。
   */
  finalize(status: "completed" | "failed" | "interrupted", finalMessage: { id?: string; content: string; metadata?: Record<string, unknown> } | null): void {
    let finalMessageId: string | undefined;
    this.store.runInTransaction((tx) => {
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
      } else if (finalMessage) {
        const input: import("./contracts.js").AddMessageInput = {
          sessionId: this.ctx.sessionId,
          role: "assistant",
          content: finalMessage.content,
        threadKey: this.ctx.threadKey,
          // finalMessageMeta（agent/thread/scope/execution_kind）打底，调用点 messageMetadata（retry_of_*）盖之，finalMessage 自带 metadata 优先。
        metadata: {
          ...this.finalMessageMeta(),
          msg_type: "assistant_final",
          ...(this.ctx.messageMetadata ?? {}),
          ...(finalMessage.metadata ?? {}),
        },
      };
       if (finalMessage.id) {
         input.messageId = finalMessage.id;
       }
       const msg = tx.addMessage(input);
       tx.updateRunStepsMessageId(this.ctx.sessionId, this.ctx.runId, msg.id);
       finalMessageId = msg.id;
     }
      // 终态 run_step（final + run:end），对齐 backend-ts execution.step 契约。
      this.persistTerminalSteps(tx, status, finalMessageId ?? null, finalMessage?.content ?? "");
   });
   this.store.updateRunStatus(this.ctx.runId, status, finalMessageId);
    this.events.close();
  }

  close(): void {
    this.events.close();
  }

  private persist(event: KernelEvent): void {
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
      case "first_token":
      case "output_delta":
      case "intent_delta":
      case "error":
        break;
      case "context_usage":
        // 纯遥测，仅推流（emit 已 push 进 events 队列），无落库副作用。
        break;
    }
  }

 private persistIntentComplete(event: KernelEvent & { type: "intent_complete" }): void {
   this.store.runInTransaction((tx) => {
     tx.addRunStep({
       sessionId: this.ctx.sessionId,
       runId: this.ctx.runId,
       stepType: "intent",
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
      stepType: "tool",
       payload: this.buildToolStepPayload(event, phase),
     });
   });
 }
 
  /** tool run_step payload（对齐 backend-ts execution.step 契约：step_id/parent_step_id/display_name/task_id/request_id/status）。 */
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

  /** run_step payload 公共字段（run_id/task_id/request_id/execution_kind；按可用性展开）。 */
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

  /** 中间 message 公共 metadata（react_intermediate + run/task/request/agent/thread/scope/visible/execution_kind；对齐旧内核契约）。 */
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

  /**
   * 终态 run_step：completed 落 final + run:end；failed/interrupted 仅落 run:end。
   * 对齐 backend-ts buildFinalStepPayload / buildRunEndStepPayload 契约（step_id/parent_step_id/display_name/task_id/request_id/status/result_preview）。
   */
  private persistTerminalSteps(tx: RuntimeTx, status: "completed" | "failed" | "interrupted", finalMessageId: string | null, finalContent: string): void {
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

 private persistAssistantMessage(message: ChatMessage, round: number): void {
   this.store.runInTransaction((tx) => {
     const input: import("./contracts.js").AddMessageInput = {
       sessionId: this.ctx.sessionId,
       role: "assistant",
       content: message.content,
        threadKey: this.ctx.threadKey,
          metadata: { ...this.messageMeta(round), msg_type: "intent" },
      };
       if (message.tool_calls) {
         input.toolCalls = message.tool_calls;
       }
       tx.addMessage(input);
     });
   }

  private persistObservations(messages: readonly ChatMessage[], round: number): void {
   this.store.runInTransaction((tx) => {
      for (const message of messages) {
        const input: import("./contracts.js").AddMessageInput = {
          sessionId: this.ctx.sessionId,
       role: "tool",
       content: message.content,
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

  private closeDanglingToolCalls(tx: RuntimeTx): void {
    const recent = this.store.listMessages(this.ctx.sessionId, this.ctx.threadKey, 1000);
    const answered = new Set<string>();
    for (const message of recent) {
      if (message.role === "tool" && message.toolCallId) {
        answered.add(message.toolCallId);
      }
    }
    for (const message of recent) {
      if (message.role !== "assistant" || !message.toolCalls || message.toolCalls.length === 0) {
        continue;
      }
      if (message.metadata.run_id !== this.ctx.runId) {
        continue;
      }
      const round = resolveRound(message.metadata.round);
      let order = 1;
      for (const toolCall of message.toolCalls) {
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
          stepType: "tool",
          payload: { kind: "tool", phase: "end", tool_name: toolCall.function.name, call_id: toolCall.id, round, order, success: false, observation: INTERRUPTED_OBSERVATION, summary: INTERRUPTED_SUMMARY, agent_name: this.ctx.agentName, run_id: this.ctx.runId },
        });
        order += 1;
      }
    }
  }
}

const INTERRUPTED_OBSERVATION = "工具执行被中断";
const INTERRUPTED_SUMMARY = "工具执行被中断";

function resolveRound(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value - 1) : 0;
}
