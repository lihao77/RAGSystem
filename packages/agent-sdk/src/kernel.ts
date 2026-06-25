/**
 * ReAct 主循环骨架（设计稿 §4，迁自 backend-ts kernel/agent-kernel.ts）。
 *
 * 内核只回答"下一步"：轮次推进、abort 检查、round 计数、消息 append 时机、终止判断。
 * 它不知道怎么组上下文 / 问模型 / 解析 / 调工具 / 落库。三只手（Protocol / ToolProvider /
 * MessageRefresher）+ EventSink 导线 + 事件 Hook 全部构造注入，内核绝不 import 任何具体实现。
 *
 * 循环顺序：
 *   throwIfAborted → appendMessages(refresher 增量) → round.before hook
 *   → context.buildMessages → protocol.invoke（问模型 + 边流边解析 + 发 delta + 修复重试，全在 invoke 内部）
 *   → round.after hook → 若 tool_calls 则 tools.executeRound + appendAssistant
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
  KernelResult,
  MessageRefresher,
  Protocol,
  RuntimeSession,
  ToolProvider,
} from "./contracts.js";
import type { HookRegistry } from "./hooks/types.js";
import type { AgentProfile } from "./types.js";
import { KernelContext } from "./kernel-context.js";

/**
 * 上下文用量计算端口：从当前轮请求消息 + profile 算 token 分桶与预算。
 * 内核本身不做 token 估算/预算解析（零兜底），由 createRuntime 注入实现。
 * 返回 ContextUsageEvent 除 type/agentName/round 外的字段。
 */
export interface ContextUsageProvider {
  (requestMessages: import("@ragsystem/agent-llm").ChatMessage[], profile: AgentProfile): {
    systemPromptTokens: number;
    historyTokens: number;
    totalTokens: number;
    budgetTokens: number;
    compressing: boolean;
  };
}

export interface AgentKernelOptions {
  context: Context;
  protocol: Protocol;
  tools: ToolProvider;
  events: EventSink;
  refresher: MessageRefresher;
  hooks: HookRegistry;
  /** 上下文用量遥测端口（可选；无则不报 context_usage 事件）。 */
  contextUsage?: ContextUsageProvider;
}

export class AgentKernel {
  private readonly context: Context;
  private readonly protocol: Protocol;
  private readonly tools: ToolProvider;
  private readonly events: EventSink;
  private readonly refresher: MessageRefresher;
  private readonly hooks: HookRegistry;
  private readonly contextUsage: ContextUsageProvider | null;

  constructor(options: AgentKernelOptions) {
    this.context = options.context;
    this.protocol = options.protocol;
    this.tools = options.tools;
    this.events = options.events;
    this.refresher = options.refresher;
    this.hooks = options.hooks;
    this.contextUsage = options.contextUsage ?? null;
  }

  async run(session: RuntimeSession): Promise<KernelResult> {
    const ctx = KernelContext.create(session);
    const agentName = session.profile.agentName;
    await this.hooks.emit("run.before", { session });
    try {
      for (let round = 0; ; round++) {
        ctx.throwIfAborted();
        ctx.appendMessages(await this.refresher.refresh(ctx));
        await this.hooks.emit("round.before", { ctx, round });
        ctx.setRequestMessages(this.context.buildMessages(ctx));
        // 请求消息组好后报上下文用量（消费端推 context_usage 遥测）。无 provider 时不报。
        if (this.contextUsage) {
          const usage = this.contextUsage(ctx.requestMessages, session.profile);
          this.events.emit({ type: "context_usage", agentName, round, ...usage });
        }
        const outcome = await this.protocol.invoke(ctx, round);
        await this.hooks.emit("round.after", { ctx, round, outcome });

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
      const result = ctx.toResult();
      await this.hooks.emit("run.after", { session, result });
      return result;
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
