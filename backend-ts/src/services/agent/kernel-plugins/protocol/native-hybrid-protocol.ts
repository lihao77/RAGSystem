/**
 * Agent 微内核 — Native Hybrid 协议（厂商 function calling）。
 *
 * 与 XmlProtocol 的核心差异（native FC 是厂商结构化输出，非 XML 文本）：
 * - 不用 StreamingRuntimeXmlParser：直接消费 llm-chat-client 拼好的 chunk.toolCalls
 *   （Phase 2.2 client 已在 readOpenAiCompatibleStream / readAnthropicStream 里累积、
 *   分片拼装、流末一次性吐出 toolCalls）。
 * - buildRequestShell 保留 native tools：写入 request.tools（toChatToolDefinition）
 *   + toolChoice:"auto"——与 XmlProtocol 的 withoutNativeTools 相反。
 * - renderObservations 产 role:"tool" 消息（每工具一条，tool_call_id 关联），
 *   不是 XML 的单条 user 消息。
 * - 无协议修复重试：native 是结构化输出，不存在"标签没闭合"。
 *
 * 铁律（同 XmlProtocol）：content 逐字 emit（不攒整段），first_token 在首个非空 content
 *   chunk 触发；toolCalls 流末一次性（native arguments 分片在 client 侧已拼好）。
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatStreamChunkHandler,
  ChatToolCall,
  LlmChatClient,
} from "../../../integrations/llm-chat-client.js";
import { RuntimeAbortError, throwIfAborted } from "../../../runtime/abort.js";
import { toChatToolDefinition } from "../tools/tool-call-utils.js";
import { resolveRequestLlmParams } from "../../../runtime/llm-params.js";
import type {
  EventSink,
  KernelContext,
  KernelObservation,
  KernelOutcome,
  KernelToolCall,
  Protocol,
} from "../../kernel/contracts.js";

/**
 * Native Hybrid 协议实现。
 *
 * eventSink 由装配注入，invoke 边流边发事件（事件类型与 data 字段一字不改，
 * 对照 XmlProtocol 的 first_token / output_delta）。llmChatClient.stream 在生产恒存在；
 * stream 分流与 XmlProtocol 一致：有 stream → invokeStreaming，无 → invokeNonStreaming。
 */
export class NativeHybridProtocol implements Protocol {
  constructor(
    private readonly llmChatClient: LlmChatClient,
    private readonly eventSink: EventSink,
  ) {}

  /**
   * 组请求壳（model/provider/temperature/signal）+ native tools。
   *
   * 与 XmlProtocol 的关键差异：native 模式下发 request.tools + toolChoice:"auto"
   * （XmlProtocol 的 withoutNativeTools 在此不复现）。visibleTools 探测同 XmlProtocol——
   * 由 session.toolExecutor + session.toolContext 共同决定。
   */
  private buildRequestShell(ctx: KernelContext): ChatCompletionRequest {
    const session = ctx.session;
    const llmParams = resolveRequestLlmParams(session.agent, session.provider, session.modelName);
    const request: ChatCompletionRequest = {
      messages: ctx.requestMessages,
      model: session.modelName,
      provider: session.provider,
      agent: session.agent,
      temperature: llmParams.temperature,
      maxCompletionTokens: llmParams.maxCompletionTokens,
    };
    if (session.signal) {
      request.signal = session.signal;
    }
    const visibleTools =
      session.toolExecutor && session.toolContext
        ? session.toolExecutor.listVisibleTools(session.agent)
        : [];
    if (visibleTools.length > 0) {
      request.tools = visibleTools.map(toChatToolDefinition);
      request.toolChoice = "auto";
    }
    return request;
  }

  /**
   * 问模型 + 边流边发 delta（消费 client 拼好的 native toolCalls）。
   *
   * 分流与 XmlProtocol 一致：client 支持 stream → 流式（逐字 emit + 流末 toolCalls）；
   * 否则非流式（complete 拿完整响应）。无协议修复重试——native 是结构化输出。
   */
  async invoke(ctx: KernelContext, round: number): Promise<KernelOutcome> {
    const baseRequest = this.buildRequestShell(ctx);
    const stream = this.llmChatClient.stream;
    if (stream) {
      return this.invokeStreaming(ctx, baseRequest, round, stream.bind(this.llmChatClient));
    }
    return this.invokeNonStreaming(ctx, baseRequest, round);
  }

  /**
   * 流式 invoke：逐字 emit content delta + 累积 client 拼好的 toolCalls。
   *
   * onChunk guard：content 或 toolCalls 任一非空都处理（不像 XmlProtocol 的
   * `if (!chunk.content) return`）。不 stopAfterClosingTag——native 要读完整个流
   * （arguments 分片可能持续，client 已在其侧拼好整段后于流末吐 toolCalls）。
   */
  private async invokeStreaming(
    ctx: KernelContext,
    baseRequest: ChatCompletionRequest,
    round: number,
    stream: (
      request: ChatCompletionRequest,
      onChunk: ChatStreamChunkHandler,
    ) => Promise<ChatCompletionResult>,
  ): Promise<KernelOutcome> {
    const session = ctx.session;
    const agentName = session.agent.agent_name;
    const signal = session.signal;

    let firstChunkSeen = false;
    const providerStartedAt = Date.now();
    let accumulatedContent = "";
    const toolCalls: ChatToolCall[] = [];

    const result = await stream(baseRequest, async (chunk) => {
      throwIfAborted(signal, "Agent run aborted");
      // 任一非空都处理：content 逐字 emit，toolCalls 累积（流末用）。
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        toolCalls.push(...chunk.toolCalls);
      }
      if (chunk.content) {
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          this.eventSink.emit({
            type: "runtime.first_token",
            data: {
              elapsed_ms: Date.now() - providerStartedAt,
              agent_name: agentName,
            },
          });
        }
        accumulatedContent += chunk.content;
        this.eventSink.emit({
          type: "runtime.output_delta",
          data: {
            content: chunk.content,
            agent_name: agentName,
          },
        });
      }
      return undefined;
    });
    throwIfAborted(signal, "Agent run aborted");

    if (result.finishReason === "interrupted") {
      throw new RuntimeAbortError("LLM stream interrupted");
    }

    if (toolCalls.length > 0) {
      const calls: KernelToolCall[] = toolCalls.map((tc, index) => ({
        index,
        callId: tc.id ?? `native_round_${round}_call_${index + 1}`,
        toolName: tc.function.name,
        arguments: safeParseArguments(tc.function.arguments),
      }));
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: accumulatedContent,
        tool_calls: toolCalls,
      };
      return {
        kind: "tool_calls",
        calls,
        assistantMessage,
        finishReason: result.finishReason ?? null,
      };
    }

    return {
      kind: "final",
      finalAnswer: accumulatedContent,
      assistantMessage: { role: "assistant", content: accumulatedContent },
      finishReason: result.finishReason ?? null,
    };
  }

  /**
   * 非流式 invoke：client 无 stream 时走 complete，拿完整响应。
   * 不发 first_token / output_delta（非流式无逐字流，结果由内核 done 事件交付）。
   */
  private async invokeNonStreaming(
    ctx: KernelContext,
    request: ChatCompletionRequest,
    round: number,
  ): Promise<KernelOutcome> {
    const signal = ctx.session.signal;
    throwIfAborted(signal, "Agent run aborted");
    const result = await this.llmChatClient.complete(request);
    throwIfAborted(signal, "Agent run aborted");
    if (result.finishReason === "interrupted") {
      throw new RuntimeAbortError("LLM stream interrupted");
    }

    if (result.toolCalls && result.toolCalls.length > 0) {
      const calls: KernelToolCall[] = result.toolCalls.map((tc, index) => ({
        index,
        callId: tc.id ?? `native_round_${round}_call_${index + 1}`,
        toolName: tc.function.name,
        arguments: safeParseArguments(tc.function.arguments),
      }));
      return {
        kind: "tool_calls",
        calls,
        assistantMessage: {
          role: "assistant",
          content: result.content,
          tool_calls: result.toolCalls,
        },
        finishReason: result.finishReason ?? null,
      };
    }

    return {
      kind: "final",
      finalAnswer: result.content,
      assistantMessage: { role: "assistant", content: result.content },
      finishReason: result.finishReason ?? null,
    };
  }

  /**
   * observation → 消息形态（native 每工具一条 role:"tool" 消息）。
   *
   * 与 XmlProtocol 单条 user 消息相反：native 模式按 calls 顺序（index 与 observations
   * 对齐），每条产 { role:"tool", tool_call_id, name, content: observation }。
   * 厂商 API 要求 tool 消息以 tool_call_id 关联对应的 assistant tool_calls。
   */
  renderObservations(
    calls: KernelToolCall[],
    observations: KernelObservation[],
  ): ChatMessage[] {
    const byIndex = new Map<number, KernelObservation>();
    for (const observation of observations) {
      byIndex.set(observation.index, observation);
    }
    const messages: ChatMessage[] = [];
    for (const call of calls) {
      const observation = byIndex.get(call.index);
      if (!observation) {
        continue;
      }
      messages.push({
        role: "tool",
        tool_call_id: call.callId,
        name: call.toolName,
        content: observation.observation,
      });
    }
    return messages;
  }
}

/**
 * 安全解析 native toolCall.arguments（厂商以 JSON 字符串下发）。
 * 空/非法 → {}（与契约 KernelToolCall.arguments: Record<string, unknown> 兼容）。
 */
function safeParseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
