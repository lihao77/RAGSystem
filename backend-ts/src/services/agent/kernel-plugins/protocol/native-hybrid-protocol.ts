/**
 * Agent 微内核 — Native Hybrid 协议（厂商 function calling + XML content 解析）。
 *
 * 混合形态：工具调用走厂商原生 FC（结构化 chunk.toolCalls），content 走 StreamingRuntimeXmlParser
 * 解析 <intent>/<final_answer>，补齐 XmlProtocol 才有的 intent 事件链。
 * - buildRequestShell 保留 native tools：写入 request.tools（toChatToolDefinition）
 *   + toolChoice:"auto"——与 XmlProtocol 的 withoutNativeTools 相反。
 * - renderObservations 产 role:"tool" 消息（每工具一条，tool_call_id 关联），
 *   不是 XML 的单条 user 消息。
 * - 无协议修复重试：native 工具是结构化输出不存在"标签没闭合"；content 是弱约束——
 *   能解析出 <intent>/<final_answer> 就发对应事件，模型直接吐纯文本答案时 fallback 当 final。
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
import { StreamingRuntimeXmlParser } from "./xml/index.js";
import { resolveRequestLlmParams } from "../../llm-params.js";
import type {
  EventSink,
  KernelContext,
  KernelObservation,
  KernelOutcome,
  KernelToolCall,
  Protocol,
} from "../../kernel/contracts.js";

/**
 * 把单条结构化 ChatMessage 原样直传（浅拷贝）——厂商 FC 模型原生消费 content + tool_calls + role:tool，
 * 无需任何序列化。与 XmlProtocol 的 renderXmlModelMessage 对称：protocol 实例与 monitoring/调试视图
 * （renderMessagesForProvider）共用同一渲染逻辑，避免 native 渲染散落多处副本。
 */
export function renderNativeModelMessage(message: ChatMessage): ChatMessage {
  return { ...message };
}

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
   * 流式 invoke：content 走 StreamingRuntimeXmlParser（解析 <intent>/<final_answer>，
   * 逐字 emit intent_delta / output_delta / intent_complete），toolCalls 走 FC 结构化字段。
   *
   * 弱约束 fallback：模型未用任何协议标签、直接吐纯文本时，缓存原始 delta，流末补发为
   * output_delta 并当 final_answer。不 stopAfterClosingTag——native 没有 <tool_calls> 标签
   * 要截断，且要读完整个流（arguments 分片持续，client 已拼好整段后于流末吐 toolCalls）。
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

    const parser = new StreamingRuntimeXmlParser();
    let firstChunkSeen = false;
    const providerStartedAt = Date.now();
    let intent = "";
    let finalAnswer = "";
    let protocolTagSeen = false;
    const pendingFallbackDeltas: string[] = [];
    const toolCalls: ChatToolCall[] = [];

    const result = await stream(baseRequest, async (chunk) => {
      throwIfAborted(signal, "Agent run aborted");
      // toolCalls 走 FC 结构化字段（client 侧已拼好整段，流末一次性）。
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        toolCalls.push(...chunk.toolCalls);
      }
      if (!chunk.content) {
        return undefined;
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        this.eventSink.emit({
          type: "runtime.first_token",
          data: { elapsed_ms: Date.now() - providerStartedAt, agent_name: agentName },
        });
      }
      const events = parser.feed(chunk.content);
      let sawOpenInThisChunk = false;
      for (const event of events) {
        if (event.type === "tag_open") {
          protocolTagSeen = true;
          sawOpenInThisChunk = true;
        }
        if (event.type === "content" && event.tag === "intent") {
          intent += event.content;
          this.eventSink.emit({
            type: "runtime.intent_delta",
            data: { content: event.content, agent_name: agentName, round },
          });
        }
        if (event.type === "content" && event.tag === "final_answer") {
          finalAnswer += event.content;
          this.eventSink.emit({
            type: "runtime.output_delta",
            data: { content: event.content, agent_name: agentName },
          });
        }
        if (event.type === "tag_close" && event.tag === "intent") {
          this.eventSink.emit({
            type: "runtime.intent_complete",
            data: { content: intent, agent_name: agentName, round },
          });
        }
      }
      // fallback 缓存：尚未见到任何协议标签、当前在标签外、本 chunk 未触发事件且不以 "<" 开头——
      // 视为纯文本候选，缓存到流末统一判定（对齐 XmlProtocol 的 pendingFallbackDeltas）。
      if (
        !protocolTagSeen &&
        !sawOpenInThisChunk &&
        parser.currentState === null &&
        events.length === 0 &&
        !chunk.content.trimStart().startsWith("<")
      ) {
        pendingFallbackDeltas.push(chunk.content);
      }
      return undefined;
    });
    throwIfAborted(signal, "Agent run aborted");

    if (result.finishReason === "interrupted") {
      throw new RuntimeAbortError("LLM stream interrupted");
    }

    const sawProtocolTag = Boolean(
      parser.getTagContent("intent").trim() || parser.getTagContent("final_answer").trim(),
    );
    if (!sawProtocolTag) {
      // 纯文本回退：模型未用 XML 协议标签，逐字补发积压的 delta 作为最终答案增量。
      for (const content of pendingFallbackDeltas) {
        this.eventSink.emit({
          type: "runtime.output_delta",
          data: { content, agent_name: agentName },
        });
      }
    }

    if (toolCalls.length > 0) {
      const calls: KernelToolCall[] = toolCalls.map((tc, index) => ({
        index,
        callId: tc.id ?? `native_round_${round}_call_${index + 1}`,
        toolName: tc.function.name,
        arguments: safeParseArguments(tc.function.arguments),
      }));
      // assistantMessage.content = 解析出的 intent 文本（调工具轮的动作说明；无 intent 则空串）。
      // 与 XmlProtocol 的 tool_calls 分支同形态（content=intent, tool_calls=结构化字段）。
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: parser.getTagContent("intent"),
        tool_calls: toolCalls,
      };
      return {
        kind: "tool_calls",
        calls,
        assistantMessage,
        finishReason: result.finishReason ?? null,
      };
    }

    const rawContent = parser.getFullResponse() || result.content || "";
    return {
      kind: "final",
      finalAnswer: finalAnswer.trim() ? finalAnswer : rawContent,
      assistantMessage: {
        role: "assistant",
        content: finalAnswer.trim() ? finalAnswer : rawContent,
      },
      finishReason: result.finishReason ?? null,
    };
  }

  /**
   * 非流式 invoke：client 无 stream 时走 complete，拿完整响应后整体 XML 解析。
   * 不发 first_token / output_delta / intent_delta（非流式无逐字流，结果由内核 done 事件交付）。
   * content 弱约束：解析出 <final_answer> 用之，否则用原始 content 兜底。
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

    const parser = new StreamingRuntimeXmlParser();
    parser.feed(result.content || "");
    const finalAnswer = parser.getTagContent("final_answer");
    const content = finalAnswer.trim() ? finalAnswer : result.content || "";

    if (result.toolCalls && result.toolCalls.length > 0) {
      const calls: KernelToolCall[] = result.toolCalls.map((tc, index) => ({
        index,
        callId: tc.id ?? `native_round_${round}_call_${index + 1}`,
        toolName: tc.function.name,
        arguments: safeParseArguments(tc.function.arguments),
      }));
      // 非流式无逐字 intent 事件；assistantMessage.content 取解析出的 intent 文本（可能空）。
      return {
        kind: "tool_calls",
        calls,
        assistantMessage: {
          role: "assistant",
          content: parser.getTagContent("intent"),
          tool_calls: result.toolCalls,
        },
        finishReason: result.finishReason ?? null,
      };
    }

    return {
      kind: "final",
      finalAnswer: content,
      assistantMessage: { role: "assistant", content },
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

  /**
   * FC 直传结构化 ChatMessage（厂商模型原生消费 content + tool_calls + role:tool）。
   * 不做 XML 包装——与 XmlProtocol.toModelMessages 的序列化分叉，是收敛在 protocol 层的物理边界。
   */
  toModelMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(renderNativeModelMessage);
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
