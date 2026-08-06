/**
 * ReAct 主循环骨架（设计稿 §4，迁自 backend-ts kernel/agent-kernel.ts）。
 *
 * 内核只回答"下一步"：轮次推进、abort 检查、round 计数、消息 append 时机、终止判断。
 * 它不知道怎么组上下文 / 问模型 / 解析 / 调工具 / 落库。三只手（Protocol / ToolProvider /
 * MessageRefresher）+ EventSink 导线 + 事件 Hook 全部构造注入，内核绝不 import 任何具体实现。
 *
 * 循环顺序：
 *   扫描并重执行会话中未配对的 tool_use →
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
import { isAbortError } from "./abort.js";
import { RecoverableInterrupt } from "./recoverable-interrupt.js";
import type { ChatMessage, LlmRequest, TokenUsage } from "@ragsystem/agent-llm";
import type {
  Context,
  EventSink,
  KernelResult,
  KernelToolCall,
  MessageRefresher,
  Protocol,
  RuntimeSession,
  ToolProvider,
} from "./contracts.js";
import type { HookRegistry } from "./hooks/types.js";
import type { AgentProfile } from "./types.js";
import { KernelContext } from "./kernel-context.js";
import type { ContextUsageSnapshot } from "./kernel-events.js";

/**
 * 上下文用量计算端口：从当前轮最终 provider request + profile 算 token 分桶与预算。
 * 内核本身不做 token 估算/预算解析（零兜底），由 createRuntime 注入实现。
 * 返回 ContextUsageEvent 除 type/agentName/round/source 外的字段。
 */
export interface ContextUsageProvider {
  (
    requestMessages: ChatMessage[],
    profile: AgentProfile,
    /** Final provider request; omitted by older/custom callers. */
    request?: LlmRequest,
  ): ContextUsageSnapshot;
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
      let tokenUsage: TokenUsage | null = null;
      const startRound = session.startRound;
      const resumeRound = collectUnansweredToolRound(ctx.messages, session.resumeToolResults);
      if (resumeRound.calls.length > 0) {
        // 未配对的 tool_use 属于恢复前最后一个 assistant 轮次；工具完成后模型从
        // startRound 继续。新 run 的防御性回退仍使用 round 0。
        const observations = await this.tools.executeRound(
          ctx,
          Math.max(0, startRound - 1),
          resumeRound.calls,
          resumeRound.previousResults,
        );
        ctx.appendMessages(this.protocol.renderObservations(resumeRound.calls, observations));
      }
      for (let round = startRound; ; round++) {
        ctx.throwIfAborted();
        ctx.appendMessages(await this.refresher.refresh(ctx, round));
        const roundBeforeOut = await this.hooks.emit("round.before", { ctx, round });
        ctx.setRequestMessages(this.context.buildMessages(ctx));
        // round.before hook 可注入 additionalContext：以 user role + 语义标签追加。
        // 不进 system 段（避免进 system 缓存段、内容变化连带击穿 prompt+memory 的 KV cache）；
        // Anthropic 路径由 buildAnthropicBody 合并进相邻 user 消息，规避 user/assistant 交替硬约束。
        if (roundBeforeOut.additionalContext) {
          ctx.requestMessages.push({
            role: "user",
            content: `<additional_context>\n${roundBeforeOut.additionalContext}\n</additional_context>`,
          });
        }
        // Protocol buildRequest adds protocol instructions and native tool schemas. Estimate the
        // final provider request rather than the pre-protocol message list.
        let requestContextUsage: ContextUsageSnapshot | null = null;
        if (this.contextUsage) {
          const providerRequest = this.protocol.buildRequest(ctx);
          requestContextUsage = this.contextUsage(providerRequest.messages, session.profile, providerRequest);
          this.events.emit({ type: "context_usage", agentName, round, source: "estimate", ...requestContextUsage });
        }
        this.events.emit({ type: "model_request", agentName, round });
        const outcome = await this.protocol.invoke(ctx, round);
        // 累计各轮 LLM 调用的 token 用量,run 结束时随 KernelResult 透出。
        if (outcome.usage) {
          tokenUsage = tokenUsage
            ? {
                inputTokens: tokenUsage.inputTokens + outcome.usage.inputTokens,
                outputTokens: tokenUsage.outputTokens + outcome.usage.outputTokens,
                totalTokens: tokenUsage.totalTokens + outcome.usage.totalTokens,
              }
            : { ...outcome.usage };
        }
        await this.hooks.emit("round.after", {
          ctx,
          round,
          outcome,
          ...(requestContextUsage ? { contextUsage: requestContextUsage } : {}),
        });
        if (requestContextUsage && outcome.usage && outcome.usage.inputTokens > 0) {
          const actualInputTokens = Math.floor(outcome.usage.inputTokens);
          // After the response, the assistant output becomes part of the next request's
          // context. Report the post-round context baseline rather than the just-finished
          // request input alone. Both values come directly from provider usage, and emit
          // only after round.after has persisted the same baseline for the session.
          const actualOutputTokens = Math.max(0, Math.floor(outcome.usage.outputTokens));
          const postRoundContextTokens = actualInputTokens + actualOutputTokens;
          const actualSystemTokens = Math.min(requestContextUsage.systemPromptTokens, postRoundContextTokens);
          this.events.emit({
            type: "context_usage",
            agentName,
            round,
            source: "provider",
            systemPromptTokens: actualSystemTokens,
            historyTokens: Math.max(0, postRoundContextTokens - actualSystemTokens),
            totalTokens: postRoundContextTokens,
            budgetTokens: requestContextUsage.budgetTokens,
            compressing: false,
          });
        }

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
          // observation 回填：renderObservations 产物 append 进工作副本；结果消息由 tool_result 事件逐工具落库（与 run_step 同粒度）。
          ctx.appendMessages(this.protocol.renderObservations(outcome.calls, observations));
          continue;
        }

        ctx.setFinalAnswer(
          outcome.kind === "final" ? (outcome.finalAnswer ?? "") : "",
          outcome.finishReason,
        );
        break;
      }
      const result = ctx.toResult();
      if (tokenUsage) {
        result.usage = tokenUsage;
      }
      await this.hooks.emit("run.after", { session, result });
      return result;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      if (error instanceof RecoverableInterrupt) {
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

/** 扫描会话中尚无 tool_result 配对的 tool_use，供 run 开始时原位重执行。 */
function collectUnansweredToolRound(
  messages: readonly ChatMessage[],
  durableResults: ReadonlyMap<string, import("./contracts.js").ToolExecutionResult>,
): { calls: KernelToolCall[]; previousResults: ReadonlyMap<number, import("./contracts.js").ToolExecutionResult> } {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && message.tool_call_id) {
      answered.add(message.tool_call_id);
    }
  }

  let selected: ChatMessage | null = null;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      continue;
    }
    if (message.tool_calls.some((toolCall) => !answered.has(toolCall.id))) selected = message;
  }
  if (!selected?.tool_calls?.length) return { calls: [], previousResults: new Map() };

  const calls: KernelToolCall[] = [];
  const previousResults = new Map<number, import("./contracts.js").ToolExecutionResult>();
  for (const [index, toolCall] of selected.tool_calls.entries()) {
    if (answered.has(toolCall.id)) {
      const result = durableResults.get(toolCall.id);
      if (result) previousResults.set(index + 1, result);
      continue;
    }
    calls.push({
        index,
        callId: toolCall.id,
        toolName: toolCall.function.name,
        arguments: JSON.parse(toolCall.function.arguments ?? "{}") as Record<string, unknown>,
    });
  }
  return { calls, previousResults };
}
