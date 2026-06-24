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
 parentCallId: string;
  /** run 入口标识 / 任务摘要 / 用户（透传 createRun，落 runs 表；可选）。 */
  entrypoint?: string | null;
  taskSummary?: string | null;
  userId?: string | null;
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
     rootCallId: this.ctx.parentCallId,
     threadKey: this.ctx.threadKey,
     parentCallId: this.ctx.parentCallId,
      ...(this.ctx.entrypoint !== undefined ? { entrypoint: this.ctx.entrypoint } : {}),
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
          metadata: { interrupted: true, agent_name: this.ctx.agentName, run_id: this.ctx.runId },
        });
        tx.updateRunStepsMessageId(this.ctx.sessionId, this.ctx.runId, anchor.id);
        finalMessageId = anchor.id;
      } else if (finalMessage) {
        const input: import("./contracts.js").AddMessageInput = {
          sessionId: this.ctx.sessionId,
          role: "assistant",
          content: finalMessage.content,
          threadKey: this.ctx.threadKey,
          metadata: { agent_name: this.ctx.agentName, run_id: this.ctx.runId, ...(finalMessage.metadata ?? {}) },
        };
        if (finalMessage.id) {
          input.messageId = finalMessage.id;
        }
        const msg = tx.addMessage(input);
        tx.updateRunStepsMessageId(this.ctx.sessionId, this.ctx.runId, msg.id);
        finalMessageId = msg.id;
      }
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
        this.persistAssistantMessage(event.message);
        break;
      case "observation_complete":
        this.persistObservations(event.messages);
        break;
      case "first_token":
      case "output_delta":
      case "intent_delta":
      case "error":
        break;
    }
  }

  private persistIntentComplete(event: KernelEvent & { type: "intent_complete" }): void {
    this.store.runInTransaction((tx) => {
      tx.addRunStep({
        sessionId: this.ctx.sessionId,
        runId: this.ctx.runId,
        stepType: "intent",
        payload: { kind: "intent", content: event.content, round: event.round, agent_name: event.agentName, run_id: this.ctx.runId },
      });
    });
  }

  private persistToolStep(event: KernelEvent & { type: "tool_call" | "tool_result" }, phase: "start" | "end"): void {
    this.store.runInTransaction((tx) => {
      tx.addRunStep({
        sessionId: this.ctx.sessionId,
        runId: this.ctx.runId,
        stepType: "tool",
        payload: {
          kind: "tool",
          phase,
          tool_name: event.toolName,
          call_id: event.toolCallId,
          arguments: event.type === "tool_call" ? event.arguments : {},
          round: event.round,
          order: event.order,
          round_index: event.roundIndex,
          agent_name: event.agentName,
          run_id: this.ctx.runId,
          ...(event.type === "tool_result"
            ? { success: event.success, observation: event.observation, summary: event.summary, elapsed_time: event.elapsedTime }
            : {}),
        },
      });
    });
  }

  private persistAssistantMessage(message: ChatMessage): void {
    this.store.runInTransaction((tx) => {
      const input: import("./contracts.js").AddMessageInput = {
        sessionId: this.ctx.sessionId,
        role: "assistant",
        content: message.content,
        threadKey: this.ctx.threadKey,
        metadata: { agent_name: this.ctx.agentName, run_id: this.ctx.runId, react_intermediate: true },
      };
      if (message.tool_calls) {
        input.toolCalls = message.tool_calls;
      }
      tx.addMessage(input);
    });
  }

  private persistObservations(messages: readonly ChatMessage[]): void {
    this.store.runInTransaction((tx) => {
      for (const message of messages) {
        const input: import("./contracts.js").AddMessageInput = {
          sessionId: this.ctx.sessionId,
          role: "tool",
          content: message.content,
          threadKey: this.ctx.threadKey,
          metadata: { agent_name: this.ctx.agentName, run_id: this.ctx.runId, msg_type: "observation" },
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
