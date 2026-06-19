/**
 * Agent 微内核 — KernelContext 状态机。
 *
 * 重要边界：session.conversation 是只读快照（一次 run 的初始输入），
 * ctx.messages 是可变工作副本（初始 = session.conversation 浅拷贝）。
 * 插件不得 mutate session；所有消息追加只能走 ctx.appendMessages / ctx.appendAssistant。
 *
 * 内核循环每轮顺序：throwIfAborted → appendMessages(refresher 增量) → beforeModel hook
 *   → protocol.invoke → afterModel hook → 若 tool_calls 则 tools.executeRound + appendAssistant
 *   + appendMessages(renderObservations) 再 continue；否则 setFinalAnswer + break。
 */

import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import type { KernelResult, KernelSession } from "./contracts.js";
import { throwIfAborted } from "../../runtime/abort.js";

export class KernelContext {
  /** 可变工作副本：初始 = session.conversation 的浅拷贝。 */
  readonly messages: ChatMessage[];
  /** 只读快照，插件不得 mutate。 */
  readonly session: KernelSession;

  private finalAnswer: string | null = null;
  private finishReason: string | null = null;

  private constructor(session: KernelSession) {
    this.session = session;
    // 浅拷贝：拷贝数组外壳，使 append 只影响工作副本，不污染调用方传入的快照。
    this.messages = [...session.conversation];
  }

  static create(session: KernelSession): KernelContext {
    return new KernelContext(session);
  }

  /**
   * 追加消息（observation 回填 / refresher 增量 / renderObservations 产物）。
   * 现状等价于 messages.push(...msgs) 的就地扩展。
   */
  appendMessages(msgs: ChatMessage[]): void {
    for (const msg of msgs) {
      this.messages.push(msg);
    }
  }

  /**
   * 追加 assistant 中间消息（工具调用态下，把 assistantMessage 落回工作副本）。
   */
  appendAssistant(msg: ChatMessage): void {
    this.messages.push(msg);
  }

  /**
   * abort 检查点。复用 abort.js 的 throwIfAborted，抛 RuntimeAbortError——
   * 保证 agent-kernel catch 能用 isAbortError 识别（abort 不发 error 事件），
   * 对齐现状 throwIfAborted(signal, "Agent run aborted")。
   */
  throwIfAborted(): void {
    throwIfAborted(this.session.signal, "Agent run aborted");
  }

  /**
   * 记录最终回答并退出循环。finishReason 取自 KernelOutcome（协议层流式
   * ChatCompletionResult.finishReason），对齐现状 toRuntimeResult 的 result.finishReason ?? null。
   */
  setFinalAnswer(answer: string, finishReason: string | null = null): void {
    this.finalAnswer = answer;
    this.finishReason = finishReason;
  }

  /**
   * 产出 KernelResult（对齐 AgentRuntimeResult 形状）。
   *
   * metadata 四字段源自 session（agent_name / provider_key / provider_type / model_name），
   * 与 toRuntimeResult 现状逐字一致。content 取 finalAnswer；finish_reason 取内核循环
   * setFinalAnswer 时传入的 outcome.finishReason（对齐现状 result.finishReason ?? null）。
   */
  toResult(): KernelResult {
    const result: KernelResult = {
      content: this.finalAnswer ?? "",
      finish_reason: this.finishReason,
      metadata: {
        agent_name: this.session.agent.agent_name,
        provider_key: this.session.provider.key ?? null,
        provider_type: this.session.provider.provider_type,
        model_name: this.session.modelName,
      },
    };
    return result;
  }
}
