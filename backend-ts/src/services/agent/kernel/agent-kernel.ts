/**
 * Agent 微内核 — 主循环骨架（行为零变化的结构搬家）。
 *
 * 内核只回答"下一步"：轮次推进、abort 检查、round 计数、消息 append 时机、
 * 终止判断。它不知道怎么组上下文 / 问模型 / 解析 / 调工具 / 发事件 / 落库。
 * 三只手（Protocol / ToolProvider / MessageRefresher）+ EventSink 导线 + HookRegistry
 * 全部通过构造注入，内核绝不 import 任何具体实现，只依赖 contracts.ts 的纯类型。
 *
 * 循环顺序：
 *   throwIfAborted → appendMessages(refresher 增量) → beforeModel hook
 *   → protocol.invoke（问模型 + 边流边解析 + 发 delta + 修复重试，全在 invoke 内部）
 *   → afterModel hook → 若 tool_calls 则 tools.executeRound + appendAssistant
 *   + appendMessages(renderObservations) 再 continue；否则 setFinalAnswer + break。
 *
 * 协议修复重试（maxProtocolRepairAttempts=2）整段在单次 invoke 内消化，不递增 round。
 * 中断 / observation 拼回也在插件里，内核不感知。
 *
 * 事件：
 * - runtime.done：循环结束后 emit。注意这是死事件
 *   （publishRuntimeEvent 无对应分支，经 sink 透传后被静默丢弃）——保留 emit 行为不变即可。
 * - abort：直接重抛，不发 error 事件（`!signal.aborted && !isAbortError` 守卫）。
 * - 其他异常：emit runtime.error 后重抛。
 */

import { isAbortError } from "../../runtime/abort.js";
import type {
  Context,
  EventSink,
  HookRegistry,
  KernelResult,
  KernelSession,
  MessageRefresher,
  Protocol,
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

  async run(session: KernelSession): Promise<KernelResult> {
    const ctx = KernelContext.create(session);
    try {
      for (let round = 0; ; round++) {
        ctx.throwIfAborted();
        ctx.appendMessages(await this.refresher.refresh(ctx));
        await this.hooks.invoke("beforeModel", ctx, round);
        ctx.setRequestMessages(this.context.buildMessages(ctx));
        const outcome = await this.protocol.invoke(ctx, round);
        await this.hooks.invoke("afterModel", ctx, round);
        if (outcome.kind === "tool_calls" && outcome.calls.length) {
          // 现状 L297-304：executeToolCallRound 前先 emit assistant_intermediate（content=rawContent）。
          this.events.emit({
            type: "runtime.assistant_intermediate",
            data: {
              content: outcome.assistantMessage.content,
              agent_name: session.agent.agent_name,
              round,
            },
          });
          // 现状 L305：工具执行前把 assistant 消息落回工作副本。
          ctx.appendAssistant(outcome.assistantMessage);
          // 现状 L306-318：执行工具（内部 emit tool_call/tool_result，经注入的 EventSink）。
          const observations = await this.tools.executeRound(ctx, round, outcome.calls);
          // 现状 L319：工具执行后 abort 检查点。
          ctx.throwIfAborted();
          // 现状 L320-328：observation 回填（单条 user 消息）。
          ctx.appendMessages(this.protocol.renderObservations(outcome.calls, observations));
          // 现状 L329-336：有 observation 时 emit observation_complete（content=合并 observation；
          // 该事件归宿是写消息表 addMessage，不发则 observation 不落库、跨会话丢失）。
          if (observations.length > 0) {
            const observationContent = observations
              .slice()
              .sort((left, right) => left.index - right.index)
              .map((execution) => execution.observation)
              .join("\n\n");
            this.events.emit({
              type: "runtime.observation_complete",
              data: {
                content: observationContent,
                agent_name: session.agent.agent_name,
                round,
              },
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
      this.events.emit({
        type: "runtime.done",
        data: {
          content: result.content,
          agent_name: session.agent.agent_name,
          finish_reason: result.finish_reason,
        },
      });
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.events.emit({
        type: "runtime.error",
        data: {
          message: error instanceof Error ? error.message : String(error),
          agent_name: session.agent.agent_name,
        },
      });
      throw error;
    }
  }
}
