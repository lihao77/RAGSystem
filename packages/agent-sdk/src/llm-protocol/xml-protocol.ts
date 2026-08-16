/**
 * XML 内容协议实现（迁自 backend-ts xml-protocol.ts）。
 *
 * 唯一协议：模型输出 <intent>/<tool_calls>/<final_answer> XML 阶段标签，SDK 边流边解析。
 * 工具调用不走厂商 FC——模型在文本里输出 <tool_calls>，由 StreamingRuntimeXmlParser +
 * parseRuntimeToolCallsXml 解析。协议说明 + tool_manifest 注入 system message。
 *
 * invoke 合并三层逻辑：
 * - runXmlStreamRound：边流边 XML 解析边发 delta（逐字 emit first_token/output_delta/intent_*）。
 * - 修复重试循环：解析失败（标签未闭合 / 无 tool_calls / 无 final_answer）追加 feedback 消息重试，
 *   上限 MAX_PROTOCOL_REPAIR_ATTEMPTS=2，整轮在单次 invoke 内消化，不递增内核 round。
 * - 非流式兜底：LlmClient 无 stream 时走 complete，拿完整响应后整体 XML 解析。
 *
 * 事件 emit 铁律：onChunk 回调里逐字 emit（first_token / output_delta / intent_delta），
 * 严禁改成攒完整段再 emit——会从流式退化成整段炸出。
 *
 * 与 backend-ts 差异：
 * - LlmChatClient/ChatCompletionRequest/ChatStreamChunkHandler -> LlmClient/LlmRequest/LlmStreamHandler。
 * - resolveTierLlmParams({agent,tier,runModel,systemLlm}) -> readTierParams(profile.llmTiers, "default")（零兜底）。
 * - session.agent.agent_name -> session.profile.agentName。
 * - runtime.* 事件(data 包裹) -> 扁平 KernelEvent。
 * - buildRequestShell 内部注入协议说明 + manifest 进 system message，再 toModelMessages 语义包装。
 *   XML 模式不下发 native tools 字段（withoutNativeTools）。
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatToolCall, LlmClient, LlmRequest, LlmStreamHandler, ProviderConfig, TokenUsage } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";
import { RuntimeAbortError, throwIfAborted } from "../abort.js";
import {
  parseAssistantContent,
  StreamingAssistantContentParser,
  type AssistantContentPart,
  type AssistantContentStreamEvent,
} from "../assistant-content.js";
import type { EventSink, KernelContext, KernelObservation, KernelOutcome, KernelToolCall, Protocol } from "../contracts.js";
import { buildPromptCacheKey, readTierParams } from "../llm-params/index.js";
import type { RuntimeToolDefinition } from "../prompt/tool-types.js";
import { withModelAttemptLifecycle } from "./model-attempt-lifecycle.js";
import {
  parseRuntimeToolCallsXml,
  renderProtocolFeedbackMessage,
  renderRuntimeXmlProtocolInstruction,
  renderSemanticBlock,
  StreamingRuntimeXmlParser,
  type ParsedToolCall,
} from "./xml/index.js";
import { renderXmlModelMessage } from "./message-rendering.js";

/** 协议修复重试上限（对齐 backend-ts maxProtocolRepairAttempts=2）。 */
const MAX_PROTOCOL_REPAIR_ATTEMPTS = 2;

/** XmlProtocol 构造依赖。 */
export interface XmlProtocolDeps {
  llm: LlmClient;
  events: EventSink;
  getTools: () => RuntimeToolDefinition[];
}

export class XmlProtocol implements Protocol {
  constructor(private readonly deps: XmlProtocolDeps) {}

  async invoke(ctx: KernelContext, round: number): Promise<KernelOutcome> {
    const baseRequest = withModelAttemptLifecycle(
      this.buildRequest(ctx),
      this.deps.events,
      ctx.session.profile.agentName,
      round,
    );
    const stream = this.deps.llm.stream;
    if (stream) {
      return this.invokeStreaming(ctx, baseRequest, round, stream.bind(this.deps.llm));
    }
    return this.invokeNonStreaming(ctx, baseRequest, round);
  }

  /**
   * 组"模型收到的 LLM 请求"（注入协议说明/manifest + toModelMessages 语义包装 + model/provider/参数），
   * **不调 LLM**。run 的 invoke 与 preview 共用此步——run 组完发请求，preview 组完即返回。
   * XML 模式不下发 native tools 字段（withoutNativeTools）。
   */
  buildRequest(ctx: KernelContext): LlmRequest {
    const session = ctx.session;
    const llmParams = readTierParams(session.profile.llmTiers, "default");
    const messages = this.prepareMessages(ctx.requestMessages);
    const request: LlmRequest = {
      messages,
      model: session.modelName,
      provider: session.provider as ProviderConfig,
      temperature: llmParams.temperature,
      maxCompletionTokens: llmParams.maxCompletionTokens,
      extraParams: llmParams.extraParams,
      promptCacheKey: buildPromptCacheKey(session),
      ...(session.profile.thinkingLevel ? { thinkingLevel: session.profile.thinkingLevel } : {}),
    };
    if (session.signal) {
      request.signal = session.signal;
    }
    return request;
  }

  /** 注入协议说明 + manifest 进 system message，再 toModelMessages 语义包装。 */
  private prepareMessages(requestMessages: ChatMessage[]): ChatMessage[] {
    const tools = this.deps.getTools();
    const instructionBlock = renderRuntimeXmlProtocolInstruction(tools);
    const enriched: ChatMessage[] = [];
    let injected = false;
    for (const msg of requestMessages) {
      if (!injected && msg.role === "system") {
        const parts = [
          renderSemanticBlock("system_instruction", extractText(msg.content), { source: "agent_config" }),
          instructionBlock,
        ];
        enriched.push({ role: "system", content: parts.join("\n\n") });
        injected = true;
      } else {
        enriched.push(msg);
      }
    }
    if (!injected && instructionBlock) {
      enriched.unshift({ role: "system", content: instructionBlock });
    }
    return this.toModelMessages(enriched);
  }

  /** 流式 invoke：边流边 XML 解析边发 delta + 协议修复重试。 */
  private async invokeStreaming(
    ctx: KernelContext,
    baseRequest: LlmRequest,
    round: number,
    stream: (request: LlmRequest, onChunk: LlmStreamHandler) => Promise<{ content: string; finishReason?: string | null; usage?: TokenUsage }>,
  ): Promise<KernelOutcome> {
    const signal = ctx.session.signal;
    let messages = [...baseRequest.messages];

    let protocolRepairAttempts = 0;
    for (;;) {
      throwIfAborted(signal, "Agent run aborted");
      const roundResult = await this.runXmlStreamRound(
        ctx,
        { ...baseRequest, messages, allowEmptyStream: true },
        round,
        stream,
      );
      throwIfAborted(signal, "Agent run aborted");

      if (roundResult.finishReason === "interrupted") {
        throw new RuntimeAbortError("LLM stream interrupted");
      }

      if (roundResult.error) {
        if (protocolRepairAttempts >= MAX_PROTOCOL_REPAIR_ATTEMPTS) {
          throw new Error(`XML protocol repair exceeded max attempts: ${roundResult.error}`);
        }
        protocolRepairAttempts += 1;
        messages = [
          ...messages,
          { role: "assistant", content: roundResult.rawContent },
          renderProtocolFeedbackMessage(roundResult.error, protocolRepairAttempts, MAX_PROTOCOL_REPAIR_ATTEMPTS),
        ];
        continue;
      }

      protocolRepairAttempts = 0;

      if (roundResult.toolCalls.length > 0) {
        const calls: KernelToolCall[] = roundResult.toolCalls.map((call, index) => ({
          index,
          callId: call.callId ?? randomUUID(),
          toolName: call.toolName,
          arguments: call.arguments ?? {},
        }));
        const toolCalls: ChatToolCall[] = calls.map((call) => ({
          id: call.callId,
          type: "function",
          function: { name: call.toolName, arguments: JSON.stringify(call.arguments) },
        }));
        const assistantMessage: ChatMessage = {
          role: "assistant",
          content: roundResult.intent,
          tool_calls: toolCalls,
        };
        return { kind: "tool_calls", calls, assistantMessage, finishReason: roundResult.finishReason, usage: roundResult.usage };
      }

      const content = roundResult.finalAnswer.trim() ? roundResult.finalAnswer : roundResult.fallbackAnswer;
      if (content.trim()) {
        return {
          kind: "final",
          finalAnswer: content,
          contentParts: roundResult.contentParts,
          assistantMessage: { role: "assistant", content },
          finishReason: roundResult.finishReason,
          usage: roundResult.usage,
        };
      }

      if (protocolRepairAttempts >= MAX_PROTOCOL_REPAIR_ATTEMPTS) {
        throw new Error("XML protocol repair exceeded max attempts: no final_answer or tool_calls found");
      }
      protocolRepairAttempts += 1;
      messages = [
        ...messages,
        { role: "assistant", content: roundResult.rawContent },
        renderProtocolFeedbackMessage("no final_answer or tool_calls found", protocolRepairAttempts, MAX_PROTOCOL_REPAIR_ATTEMPTS),
      ];
    }
  }

  /** 非流式 invoke：complete 拿完整响应后整体 XML 解析。不做修复重试（非流式无增量解析）。 */
  private async invokeNonStreaming(ctx: KernelContext, request: LlmRequest, round: number): Promise<KernelOutcome> {
    const signal = ctx.session.signal;
    throwIfAborted(signal, "Agent run aborted");
    const result = await this.deps.llm.complete(request);
    throwIfAborted(signal, "Agent run aborted");
    if (result.finishReason === "interrupted") {
      throw new RuntimeAbortError("LLM stream interrupted");
    }

    const parser = new StreamingRuntimeXmlParser();
    parser.feed(result.content, { stopAfterClosingTag: "tool_calls" });
    const toolCallsXml = parser.getTagContent("tool_calls");
    if (toolCallsXml.trim()) {
      const parsed = parseRuntimeToolCallsXml(toolCallsXml);
      if (parsed.calls.length > 0) {
        const calls: KernelToolCall[] = parsed.calls.map((call, index) => ({
          index,
          callId: call.callId ?? randomUUID(),
          toolName: call.toolName,
          arguments: call.arguments ?? {},
        }));
        const toolCalls: ChatToolCall[] = calls.map((call) => ({
          id: call.callId,
          type: "function",
          function: { name: call.toolName, arguments: JSON.stringify(call.arguments) },
        }));
        return {
          kind: "tool_calls",
          calls,
          assistantMessage: { role: "assistant", content: parser.getTagContent("intent"), tool_calls: toolCalls },
          finishReason: result.finishReason ?? null,
          usage: result.usage,
        };
      }
    }
    const finalAnswer = parser.getTagContent("final_answer");
    const parsedContent = parseAssistantContent(finalAnswer.trim() ? finalAnswer : result.content);
    return {
      kind: "final",
      finalAnswer: parsedContent.content,
      contentParts: parsedContent.parts,
      assistantMessage: { role: "assistant", content: parsedContent.content },
      finishReason: result.finishReason ?? null,
      usage: result.usage,
    };
  }

  /** observation -> 消息形态（role:tool + tool_call_id；给 XML 模型回填时 toModelMessages 转 role:user）。 */
  renderObservations(calls: KernelToolCall[], observations: KernelObservation[]): ChatMessage[] {
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
        content: observation.modelContent ?? observation.observation,
      });
    }
    return messages;
  }

  /** 结构化 ChatMessage[] -> XML 模型语境（物理边界）。 */
  toModelMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(renderXmlModelMessage);
  }

  /**
   * 单轮流式解析（逐字迁 backend-ts runXmlStreamRound）。
   *
   * onChunk 回调里所有 emit 经 this.deps.events.emit 发出（扁平 KernelEvent）。
   * 边流边解析：解析出 final_answer 片段立即 emit output_delta（实时通道）。
   */
  private async runXmlStreamRound(
    ctx: KernelContext,
    request: LlmRequest,
    round: number,
    stream: (request: LlmRequest, onChunk: LlmStreamHandler) => Promise<{ content: string; finishReason?: string | null; usage?: TokenUsage }>,
  ): Promise<{
    rawContent: string;
    intent: string;
    finalAnswer: string;
    contentParts: AssistantContentPart[];
    fallbackAnswer: string;
    toolCalls: ParsedToolCall[];
    finishReason: string | null;
    error: string | null;
    usage: TokenUsage | undefined;
  }> {
    const session = ctx.session;
    const agentName = session.profile.agentName;
    const signal = session.signal;

    const parser = new StreamingRuntimeXmlParser();
    const contentParser = new StreamingAssistantContentParser();
    let firstChunkSeen = false;
    const providerStartedAt = Date.now();
    let intent = "";
    let toolCallsClosed = false;
    let finalAnswerStarted = false;
    let ignoredToolCallsAfterFinal = false;
    let error: string | null = null;
    let protocolTagSeen = false;
    const pendingFallbackDeltas: string[] = [];
    const toolCalls: ParsedToolCall[] = [];

    const result = await stream(request, async (chunk) => {
      throwIfAborted(signal, "Agent run aborted");
      if (!chunk.content || toolCallsClosed) {
        return toolCallsClosed ? { stop: true } : undefined;
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        this.deps.events.emit({
          type: "first_token",
          agentName,
          elapsedMs: Date.now() - providerStartedAt,
        });
      }
      const events = parser.feed(chunk.content, { stopAfterClosingTag: "tool_calls" });
      for (const event of events) {
        if (event.type === "fallback") {
          pendingFallbackDeltas.push(event.content);
          continue;
        }
        if (event.type === "tag_open") {
          protocolTagSeen = true;
        }
        if (event.type === "tag_open" && event.tag === "final_answer") {
          finalAnswerStarted = true;
        }
        if (event.type === "tag_open" && event.tag === "tool_calls" && finalAnswerStarted) {
          ignoredToolCallsAfterFinal = true;
        }
        if (event.type === "content" && event.tag === "intent") {
          intent += event.content;
          this.deps.events.emit({
            type: "intent_delta",
            agentName,
            content: event.content,
            round,
          });
        }
        if (event.type === "content" && event.tag === "final_answer" && !toolCallsClosed) {
          emitAssistantContentEvents(this.deps.events, agentName, contentParser.feed(event.content));
        }
        if (event.type === "tag_close" && event.tag === "intent") {
          this.deps.events.emit({
            type: "intent_complete",
            agentName,
            content: intent,
            round,
          });
        }
        if (event.type === "tag_close" && event.tag === "tool_calls" && !ignoredToolCallsAfterFinal) {
          toolCallsClosed = true;
          const parsed = parseRuntimeToolCallsXml(parser.getTagContent("tool_calls"));
          if (parsed.error) {
            error = parsed.error;
          }
          toolCalls.push(...parsed.calls);
        }
      }
      if (toolCallsClosed) {
        return { stop: true };
      }
      return undefined;
    });
    throwIfAborted(signal, "Agent run aborted");

    const rawContent = parser.getFullResponse() || result.content;
    if (parser.currentState !== null && !error) {
      error = `unclosed <${parser.currentState}> tag`;
    }
    const sawProtocolTag = Boolean(
      parser.getTagContent("intent").trim() ||
        parser.getTagContent("tool_calls").trim() ||
        parser.getTagContent("final_answer").trim(),
    );
    if (!sawProtocolTag) {
      for (const content of pendingFallbackDeltas) {
        emitAssistantContentEvents(this.deps.events, agentName, contentParser.feed(content));
      }
    }
    emitAssistantContentEvents(this.deps.events, agentName, contentParser.finish());
    const fallbackAnswer = sawProtocolTag ? "" : contentParser.getFallbackContent();
    return {
      rawContent,
      intent: parser.getTagContent("intent"),
      finalAnswer: contentParser.getFallbackContent(),
      contentParts: contentParser.getParts(),
      fallbackAnswer,
      toolCalls,
      finishReason: result.finishReason ?? null,
      error,
      usage: result.usage,
    };
  }
}

function emitAssistantContentEvents(
  sink: EventSink,
  agentName: string,
  events: readonly AssistantContentStreamEvent[],
): void {
  for (const event of events) {
    if (event.type === "text_delta") {
      sink.emit({ type: "output_delta", agentName, content: event.content, partIndex: event.partIndex });
    } else {
      sink.emit({ type: "output_file_ref", agentName, partIndex: event.partIndex, part: event.part });
    }
  }
}
