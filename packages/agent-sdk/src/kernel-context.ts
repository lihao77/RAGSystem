/**
 * KernelContext —— 内核状态机（设计稿 §4，迁自 backend-ts kernel/kernel-context.ts）。
 *
 * 边界：session.conversation 是只读快照；ctx.messages 是可变工作副本（初始 = 浅拷贝）。
 * 插件不得 mutate session；所有消息追加只走 ctx.append* / ctx.replace*。
 *
 * 内核循环每轮顺序：throwIfAborted → appendMessages(refresher 增量) → beforeModel hook
 *   → context.buildMessages → protocol.invoke → afterModel hook →
 *   若 tool_calls：tools.executeRound + appendAssistant + appendMessages(renderObservations) 再 continue；
 *   否则 setFinalAnswer + break。
 *
 * 与 backend-ts 差异：metadata 从 session.agent.agent_name 改读 session.profile.agentName。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import { throwIfAborted } from "./abort.js";
import type { AssistantContentPart } from "./assistant-content.js";
import type { KernelResult, RuntimeSession } from "./contracts.js";

export class KernelContext {
  /** 可变工作副本：初始 = session.conversation 的浅拷贝。 */
  readonly messages: ChatMessage[];
  /** 当前轮请求消息（Context.buildMessages 产物）。与 messages（会话累积）分离。 */
  requestMessages: ChatMessage[] = [];
  /** 只读快照，插件不得 mutate。 */
  readonly session: RuntimeSession;

  private finalAnswer: string | null = null;
  private finalContentParts: AssistantContentPart[] = [];
  private finishReason: string | null = null;

  private constructor(session: RuntimeSession) {
    this.session = session;
    this.messages = [...session.conversation];
  }

  static create(session: RuntimeSession): KernelContext {
    return new KernelContext(session);
  }

  /** 追加消息（observation 回填 / refresher 增量 / renderObservations 产物）。 */
  appendMessages(msgs: readonly ChatMessage[]): void {
    for (const msg of msgs) {
      this.messages.push(msg);
    }
  }

  /** 设置当前轮请求消息（Context.buildMessages 产物，供 Protocol.invoke 读取）。 */
  setRequestMessages(messages: readonly ChatMessage[]): void {
    this.requestMessages = [...messages];
  }

  /** 追加 assistant 中间消息（工具调用态落回工作副本）。 */
  appendAssistant(msg: ChatMessage): void {
    this.messages.push(msg);
  }

  /** 受控重写：用单条摘要消息替换 [startIndex, startIndex+deleteCount) 区间（循环内压缩 hook 用）。 */
  replaceHistory(startIndex: number, deleteCount: number, summaryMessage: ChatMessage): void {
    if (deleteCount <= 0) {
      return;
    }
    this.messages.splice(startIndex, deleteCount, summaryMessage);
  }

  /** 整体替换工作副本（循环内重压缩：用压缩+重建后的会话换掉旧副本）。 */
  replaceAll(messages: readonly ChatMessage[]): void {
    this.messages.splice(0, this.messages.length, ...messages);
  }

  /** abort 检查点：抛 RuntimeAbortError，内核 catch 用 isAbortError 识别（abort 不发 error 事件）。 */
  throwIfAborted(): void {
    throwIfAborted(this.session.signal, "Agent run aborted");
  }

  /** 记录最终回答并退出循环。 */
  setFinalAnswer(answer: string, contentParts: AssistantContentPart[], finishReason: string | null = null): void {
    this.finalAnswer = answer;
    this.finalContentParts = contentParts;
    this.finishReason = finishReason;
  }

  /** 产出 KernelResult（metadata 源自 profile/provider，对齐 backend-ts KernelResult 形状）。 */
  toResult(): KernelResult {
    return {
      content: this.finalAnswer ?? "",
      contentParts: this.finalContentParts.map((part) => ({ ...part })),
      finishReason: this.finishReason,
      metadata: {
        agentName: this.session.profile.agentName,
        providerKey: this.session.provider.key,
        providerType: this.session.provider.provider_type,
        modelName: this.session.modelName,
      },
    };
  }
}
