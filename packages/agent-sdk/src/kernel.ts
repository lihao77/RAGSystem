/**
 * ReAct 主循环骨架（设计稿 §4，迁自 backend-ts kernel/agent-kernel.ts）。
 *
 * 内核只回答"下一步"：轮次推进、abort 检查、round 计数、消息 append 时机、终止判断。
 * 它不知道怎么组上下文 / 问模型 / 解析 / 调工具 / 落库。三只手（Protocol / ToolProvider /
 * MessageRefresher）+ EventSink 导线 + HookRegistry 全部构造注入，内核绝不 import 任何具体实现。
 *
 * 循环顺序：
 *   throwIfAborted → appendMessages(refresher 增量) → beforeModel hook
 *   → context.buildMessages → protocol.invoke（问模型 + 边流边解析 + 发 delta + 修复重试，全在 invoke 内部）
 *   → afterModel hook → 若 tool_calls 则 tools.executeRound + appendAssistant
 *   + appendMessages(renderObservations) 再 continue；否则 setFinalAnswer + break。
 *
 * 事件：发 KernelEvent（扁平运行时语义），EventSink 透传给 Dispatcher——不翻译（设计稿 §6 原则 1/4）。
 * abort：直接重抛，不发 error 事件。其他异常：emit error 后重抛。
 *
 * 与 backend-ts 差异：KernelSession → RuntimeSession；session.agent.agent_name → session.profile.agentName；
 * runtime.* 方言事件（data 包裹）→ 扁平 KernelEvent。
 */
import { isAbortError } from "@ragsystem/agent-protocol";
import type {
  Context,
  EventSink,
  HookRegistry,
  KernelResult,
  MessageRefresher,
  Protocol,
  RuntimeSession,
  ToolProvider,
} from "./contracts.js";
import { KernelContext } from "./kernel-context.js";

export interface AgentKernelOptions {
  context: Context;
  protocol: Protocol;
  tools: ToolProvider;
  events: EventSink;
  refresher: MessageRefresher;
  hooks: HookRegistry;
}

export class AgentKernel {
  private readonly context: Context;
  private readonly protocol: Protocol;
  private readonly tools: ToolProvider;
  private readonly events: EventSink;
  private readonly refresher: MessageRefresher;
  private readonly hooks: HookRegistry;

  constructor(options: AgentKernelOptions) {
    this.context = options.context;
    this.protocol = options.protocol;
    this.tools = options.tools;
    this.events = options.events;
    this.refresher = options.refresher;
    this.hooks = options.hooks;
  }

  async run(session: RuntimeSession): Promise<KernelResult> {
    const ctx = KernelContext.create(session);
    const agentName = session.profile.agentName;
    try {
      for (let round = 0; ; round++) {
        ctx.throwIfAborted();
        ctx.appendMessages(await this.refresher.refresh(ctx));
        await this.hooks.invoke("beforeModel", ctx, round);
        ctx.setRequestMessages(this.context.buildMessages(ctx));
        const outcome = await this.protocol.invoke(ctx, round);
        await this.hooks.invoke("afterModel", ctx, round);

        if (outcome.kind === "tool_calls" && outcome.calls.length > 0) {
          // executeRound 前先 emit assistant_intermediate，把工具调用态 assistant 消息透传。
          this.events.emit({
            type: "assistant_intermediate",
            agentName,
            round,
            message: outcome.assistantMessage,
          });
          // 工具执行前把 assistant 消息落回工作副本。
          ctx.appendAssistant(outcome.assistantMessage);
          // 执行工具（内部 emit tool_call/tool_result，经注入的 EventSink）。
          const observations = await this.tools.executeRound(ctx, round, outcome.calls);
          ctx.throwIfAborted();
          // observation 回填：renderObservations 产物 append 进工作副本 + 透传落库。
          const observationMessages = this.protocol.renderObservations(outcome.calls, observations);
          ctx.appendMessages(observationMessages);
          if (observationMessages.length > 0) {
            this.events.emit({
              type: "observation_complete",
              agentName,
              round,
              messages: observationMessages,
            });
          }
          continue;
        }

        ctx.setFinalAnswer(
          outcome.kind === "final" ? (outcome.finalAnswer ?? "") : "",
          outcome.finishReason,
        );
        break;
      }
      return ctx.toResult();
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.events.emit({
        type: "error",
        agentName,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
