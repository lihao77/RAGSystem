/**
 * XML 内容协议实现（无标签化：轮次判据唯一化为 tool_calls 有无）。
 *
 * 模型输出两种形态：裸正文（边流边 emit output_delta）与 <tool_calls> 块（唯一结构化标签，
 * 由 StreamingRuntimeXmlParser + parseRuntimeToolCallsXml 解析）。轮次性质在流结束判定——
 * 有 tool_calls 即工具轮（裸正文是动作说明，派生 intent_complete 归过程树）；纯文本即最终回答。
 * 旧协议标签 <intent>/<final_answer>/<answer> 在解析层剥离（内容透传为裸正文），模型旧习惯不泄漏进答案。
 *
 * invoke 合并三层逻辑：
 * - runXmlStreamRound：边流边解析边发 delta（逐字 emit first_token/output_delta/reasoning_*）。
 * - 修复重试循环：解析失败（tool_calls 标签未闭合/参数解析失败 / 空响应）追加 feedback 消息重试，
 *   上限 MAX_PROTOCOL_REPAIR_ATTEMPTS=2，整轮在单次 invoke 内消化，不递增内核 round。
 *   重试期间不发 intent_complete——该轮文字只在最终成功的轮末派生一次（见 emitRoundNote）。
 * - 非流式兜底：LlmClient 无 stream 时走 complete，拿完整响应后整体解析。
 *
 * 事件 emit 铁律：onChunk 回调里逐字 emit（first_token / output_delta），严禁改成攒完整段再
 * emit——会从流式退化成整段炸出。intent_* 不再流式：intent_complete 在轮次判定为工具轮时派生。
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
      thinkingLevel: session.profile.thinkingLevel ?? llmParams.thinkingLevel ?? null,
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

  /** 流式 invoke：边流边解析边发 delta + 协议修复重试。 */
  private async invokeStreaming(
    ctx: KernelContext,
    baseRequest: LlmRequest,
    round: number,
    stream: (request: LlmRequest, onChunk: LlmStreamHandler) => Promise<{ content: string; reasoning?: string; finishReason?: string | null; usage?: TokenUsage }>,
  ): Promise<KernelOutcome> {
    const signal = ctx.session.signal;
    const agentName = ctx.session.profile.agentName;
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
        // 失败尝试的裸正文不定格为 intent：intent_complete 在投影端的语义是"该轮文字
        // 定稿、轮次封口"——重试前发会把即将作废的尝试封成正式说明，重试的 delta 只能
        // 落进幻影新轮（同文两份且吞噬下一轮正文）。正文在投影端留在本轮 text 通道里
        // 续写，由最终成功时唯一一次 emitRoundNote 定稿收敛；气泡清空同样随之发生。
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
        this.emitRoundNote(agentName, round, roundResult.text);
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
          content: roundResult.text,
          tool_calls: toolCalls,
        };
        return {
          kind: "tool_calls",
          calls,
          ...(roundResult.reasoning ? { reasoning: roundResult.reasoning } : {}),
          assistantMessage,
          finishReason: roundResult.finishReason,
          usage: roundResult.usage,
        };
      }

      if (roundResult.text.trim()) {
        return {
          kind: "final",
          finalAnswer: roundResult.text,
          contentParts: roundResult.contentParts,
          ...(roundResult.reasoning ? { reasoning: roundResult.reasoning } : {}),
          assistantMessage: { role: "assistant", content: roundResult.text },
          finishReason: roundResult.finishReason,
          usage: roundResult.usage,
        };
      }

      if (protocolRepairAttempts >= MAX_PROTOCOL_REPAIR_ATTEMPTS) {
        throw new Error("XML protocol repair exceeded max attempts: empty response");
      }
      protocolRepairAttempts += 1;
      messages = [
        ...messages,
        { role: "assistant", content: roundResult.rawContent },
        renderProtocolFeedbackMessage("empty response: no text and no tool_calls", protocolRepairAttempts, MAX_PROTOCOL_REPAIR_ATTEMPTS),
      ];
    }
  }

  /** 工具轮的裸正文以派生 intent_complete 归档：过程树拿到动作说明，前端借同一信号清空消息气泡。 */
  private emitRoundNote(agentName: string, round: number, text: string): void {
    if (!text.trim()) {
      return;
    }
    this.deps.events.emit({ type: "intent_complete", agentName, content: text, round });
  }

  /** 非流式 invoke：complete 拿完整响应后整体解析。不做修复重试（非流式无增量解析）。 */
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
    parser.finish();
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
          ...(result.reasoning ? { reasoning: result.reasoning } : {}),
          assistantMessage: { role: "assistant", content: parser.getFallbackText(), tool_calls: toolCalls },
          finishReason: result.finishReason ?? null,
          usage: result.usage,
        };
      }
    }
    // 裸正文（旧标签已剥离）为最终回答；解析层无产出时退回原始 content 兜底。
    const text = parser.getFallbackText() || result.content || "";
    const parsedContent = parseAssistantContent(text);
    return {
      kind: "final",
      finalAnswer: parsedContent.content,
      contentParts: parsedContent.parts,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
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
   * 单轮流式解析。裸正文边解析边 emit output_delta（实时通道）；</tool_calls> 闭合即停流。
   * onChunk 回调里所有 emit 经 this.deps.events.emit 发出（扁平 KernelEvent）。
   */
  private async runXmlStreamRound(
    ctx: KernelContext,
    request: LlmRequest,
    round: number,
    stream: (request: LlmRequest, onChunk: LlmStreamHandler) => Promise<{ content: string; reasoning?: string; finishReason?: string | null; usage?: TokenUsage }>,
  ): Promise<{
    rawContent: string;
    text: string;
    contentParts: AssistantContentPart[];
    toolCalls: ParsedToolCall[];
    reasoning: string;
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
    let toolCallsClosed = false;
    let error: string | null = null;
    const toolCalls: ParsedToolCall[] = [];
    let reasoning = "";
    // 正文（含工具调用 XML）chunk 一出现，思考阶段事实上结束（provider 的 reasoning
    // 严格先于 content）：立即封口 reasoning_complete，不等整条流跑完——否则正文流式
    // 期间前端思考块一直停在"思考中"。流结束后的兜底 emit 用 reasoningClosed 去重。
    let reasoningClosed = false;
    const closeReasoning = () => {
      if (reasoningClosed || !reasoning) return;
      reasoningClosed = true;
      this.deps.events.emit({
        type: "reasoning_complete",
        agentName,
        content: reasoning,
        round,
      });
    };

    const result = await stream(request, async (chunk) => {
      throwIfAborted(signal, "Agent run aborted");
      if (chunk.reasoning) {
        reasoning += chunk.reasoning;
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          this.deps.events.emit({
            type: "first_token",
            agentName,
            elapsedMs: Date.now() - providerStartedAt,
          });
        }
        this.deps.events.emit({
          type: "reasoning_delta",
          agentName,
          content: chunk.reasoning,
          round,
        });
      }
      if (chunk.content) {
        closeReasoning();
      }
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
          emitAssistantContentEvents(this.deps.events, agentName, contentParser.feed(event.content));
          continue;
        }
        if (event.type === "tag_close" && event.tag === "tool_calls") {
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
    if (reasoning && !reasoningClosed) {
      this.deps.events.emit({
        type: "reasoning_complete",
        agentName,
        content: reasoning,
        round,
      });
    }

    // 流结束：冲刷解析器扣留的尾部缓冲，正文走完内容解析器。
    for (const event of parser.finish()) {
      if (event.type === "fallback") {
        emitAssistantContentEvents(this.deps.events, agentName, contentParser.feed(event.content));
      }
    }
    emitAssistantContentEvents(this.deps.events, agentName, contentParser.finish());

    const rawContent = parser.getFullResponse() || result.content;
    if (parser.currentState !== null && !error) {
      error = `unclosed <${parser.currentState}> tag`;
    }
    return {
      rawContent,
      text: contentParser.getFallbackContent(),
      contentParts: contentParser.getParts(),
      toolCalls,
      reasoning: reasoning || result.reasoning || "",
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
