/**
 * Native Hybrid 协议实现（无标签化：轮次判据唯一化为 tool_calls 有无）。
 *
 * 混合形态：工具调用走厂商原生 FC（结构化 chunk.toolCalls），content 是裸文本
 * （StreamingRuntimeXmlParser 剥离旧 <intent>/<final_answer> 标签后边流边 emit output_delta）。
 * 轮次性质在流结束判定——有 toolCalls 即工具轮（裸文本是动作说明，派生 intent_complete
 * 归过程树）；纯文本即最终回答。与 XmlProtocol 的解析判定完全一致，仅工具通道不同。
 * - buildRequestShell 保留 native tools：写入 request.tools（toChatToolDefinition）+ toolChoice:"auto"。
 * - renderObservations 产 role:"tool" 消息（每工具一条，tool_call_id 关联）。
 * - 无协议修复重试：native 工具是结构化输出不存在"标签没闭合"。
 *
 * 与 backend-ts 差异（同 XmlProtocol）：LlmClient/LlmRequest、readTierParams、扁平 KernelEvent。
 * visibleTools 来源从 session.toolExecutor 改为 deps.getTools()（SDK 工具端口尚未接入，默认空）。
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatToolCall, ChatToolDefinition, ContentPart, LlmClient, LlmRequest, LlmResult, LlmStreamHandler, ProviderConfig } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";
import { RuntimeAbortError, throwIfAborted } from "../abort.js";
import {
  parseAssistantContent,
  StreamingAssistantContentParser,
  type AssistantContentStreamEvent,
} from "../assistant-content.js";
import type { EventSink, KernelContext, KernelObservation, KernelOutcome, KernelToolCall, Protocol } from "../contracts.js";
import { buildPromptCacheKey, readTierParams } from "../llm-params/index.js";
import type { RuntimeToolDefinition } from "../prompt/tool-types.js";
import { withModelAttemptLifecycle } from "./model-attempt-lifecycle.js";
import { renderNativeXmlProtocolInstruction, StreamingRuntimeXmlParser } from "./xml/index.js";
import { renderNativeModelMessage } from "./message-rendering.js";
import { sanitizeToolPairing } from "./tool-pairing.js";

/** NativeHybridProtocol 构造依赖。 */
export interface NativeHybridProtocolDeps {
  llm: LlmClient;
  events: EventSink;
  getTools: () => RuntimeToolDefinition[];
}

export class NativeHybridProtocol implements Protocol {
  constructor(private readonly deps: NativeHybridProtocolDeps) {}

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
   * 组"模型收到的 LLM 请求"（messages 经 prepareMessages 注入 native 协议说明 + native tools +
   * model/provider/参数），**不调 LLM**。run 的 invoke 与 preview 共用此步——run 组完发请求，
   * preview 组完即返回。native 模式下发 request.tools + toolChoice:"auto"（与 XmlProtocol 的
   * withoutNativeTools 相反）。
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
    const visibleTools = this.deps.getTools();
    if (visibleTools.length > 0) {
      request.tools = visibleTools.map(toChatToolDefinition);
      request.toolChoice = "auto";
    }
    return request;
  }

  /** 注入 native 协议说明进 system message，再 toModelMessages 直传。 */
  private prepareMessages(requestMessages: ChatMessage[]): ChatMessage[] {
    const instructionBlock = renderNativeXmlProtocolInstruction();
    const enriched: ChatMessage[] = [];
    let injected = false;
    for (const msg of requestMessages) {
      if (!injected && msg.role === "system") {
        const parts = [extractText(msg.content), instructionBlock];
        enriched.push({ role: "system", content: parts.join("\n\n") });
        injected = true;
      } else {
        enriched.push(msg);
      }
    }
    if (!injected) {
      enriched.unshift({ role: "system", content: instructionBlock });
    }
    return this.toModelMessages(enriched);
  }

  /** 流式 invoke：content 裸文本边流边 emit output_delta，toolCalls 走 FC 结构化字段。 */
  private async invokeStreaming(
    ctx: KernelContext,
    baseRequest: LlmRequest,
    round: number,
    stream: (request: LlmRequest, onChunk: LlmStreamHandler) => Promise<LlmResult>,
  ): Promise<KernelOutcome> {
    const session = ctx.session;
    const agentName = session.profile.agentName;
    const signal = session.signal;

    const parser = new StreamingRuntimeXmlParser();
    const contentParser = new StreamingAssistantContentParser();
    let firstChunkSeen = false;
    const providerStartedAt = Date.now();
    const toolCalls: ChatToolCall[] = [];
    let reasoning = "";
    // 正文/工具调用 chunk 一出现，思考阶段事实上结束（provider 的 reasoning 严格先于
    // content）：立即封口 reasoning_complete，不等整条流跑完——否则正文流式期间前端
    // 思考块一直停在"思考中"。流结束后的兜底 emit 用 reasoningClosed 去重。
    let reasoningClosed = false;
    const closeReasoning = () => {
      if (reasoningClosed || !reasoning) return;
      reasoningClosed = true;
      this.deps.events.emit({ type: "reasoning_complete", agentName, content: reasoning, round });
    };

    const result = await stream(baseRequest, async (chunk) => {
      throwIfAborted(signal, "Agent run aborted");
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        toolCalls.push(...chunk.toolCalls);
      }
      if (chunk.reasoning) {
        reasoning += chunk.reasoning;
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          this.deps.events.emit({ type: "first_token", agentName, elapsedMs: Date.now() - providerStartedAt });
        }
        this.deps.events.emit({ type: "reasoning_delta", agentName, content: chunk.reasoning, round });
      }
      if (chunk.content || (chunk.toolCalls && chunk.toolCalls.length > 0)) {
        closeReasoning();
      }
      if (!chunk.content) {
        return undefined;
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        this.deps.events.emit({ type: "first_token", agentName, elapsedMs: Date.now() - providerStartedAt });
      }
      for (const event of parser.feed(chunk.content)) {
        if (event.type === "fallback") {
          emitAssistantContentEvents(this.deps.events, agentName, contentParser.feed(event.content));
        }
      }
      return undefined;
    });
    throwIfAborted(signal, "Agent run aborted");

    const reasoningText = reasoning || result.reasoning || "";
    if (reasoningText && !reasoningClosed) {
      this.deps.events.emit({ type: "reasoning_complete", agentName, content: reasoningText, round });
    }

    if (result.finishReason === "interrupted") {
      throw new RuntimeAbortError("LLM stream interrupted");
    }

    // 流结束：冲刷解析器扣留的尾部缓冲（裸正文身份由本轮结局决定——
    // 有工具调用 → 动作说明 intent；没有 → 最终答案 final）。
    for (const event of parser.finish()) {
      if (event.type === "fallback") {
        emitAssistantContentEvents(this.deps.events, agentName, contentParser.feed(event.content));
      }
    }

    if (toolCalls.length > 0) {
      const noteText = contentParser.getFallbackContent();
      if (noteText.trim()) {
        this.deps.events.emit({ type: "intent_complete", agentName, content: noteText, round });
      }
      const calls: KernelToolCall[] = toolCalls.map((tc, index) => ({
        index,
        callId: tc.id ?? randomUUID(),
        toolName: tc.function.name,
        arguments: safeParseArguments(tc.function.arguments),
      }));
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: noteText,
        tool_calls: toolCalls,
        ...(result.reasoningBlocks?.length ? { reasoning_blocks: result.reasoningBlocks } : {}),
        ...(result.providerContinuation ? { provider_continuation: result.providerContinuation } : {}),
      };
      return { kind: "tool_calls", calls, assistantMessage, finishReason: result.finishReason ?? null, usage: result.usage, ...(reasoningText ? { reasoning: reasoningText } : {}) };
    }

    emitAssistantContentEvents(this.deps.events, agentName, contentParser.finish());
    const rawContent = parser.getFullResponse() || result.content || "";
    const fallbackContent = contentParser.getFallbackContent();
    return {
      kind: "final",
      finalAnswer: fallbackContent || rawContent,
      contentParts: contentParser.getParts(),
      ...(reasoningText ? { reasoning: reasoningText } : {}),
      // final 轮的思考 continuation 也要随消息携带：跨 run 回放要求最终轮数据不丢。
      assistantMessage: {
        role: "assistant",
        content: fallbackContent || rawContent,
        ...(result.reasoningBlocks?.length ? { reasoning_blocks: result.reasoningBlocks } : {}),
        ...(result.providerContinuation ? { provider_continuation: result.providerContinuation } : {}),
      },
      finishReason: result.finishReason ?? null,
      usage: result.usage,
    };
  }

  /** 非流式 invoke：complete 拿完整响应后整体解析。裸文本（旧标签已剥离）按 toolCalls 有无定身份。 */
  private async invokeNonStreaming(ctx: KernelContext, request: LlmRequest, round: number): Promise<KernelOutcome> {
    const signal = ctx.session.signal;
    throwIfAborted(signal, "Agent run aborted");
    const result = await this.deps.llm.complete(request);
    throwIfAborted(signal, "Agent run aborted");
    if (result.finishReason === "interrupted") {
      throw new RuntimeAbortError("LLM stream interrupted");
    }

    const parser = new StreamingRuntimeXmlParser();
    parser.feed(result.content || "");
    parser.finish();
    const text = parser.getFallbackText() || (result.content || "").trim();

    if (result.toolCalls && result.toolCalls.length > 0) {
      const calls: KernelToolCall[] = result.toolCalls.map((tc, index) => ({
        index,
        callId: tc.id ?? randomUUID(),
        toolName: tc.function.name,
        arguments: safeParseArguments(tc.function.arguments),
      }));
      return {
        kind: "tool_calls",
        calls,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        assistantMessage: {
          role: "assistant",
          content: text,
          tool_calls: result.toolCalls,
          ...(result.reasoningBlocks?.length ? { reasoning_blocks: result.reasoningBlocks } : {}),
          ...(result.providerContinuation ? { provider_continuation: result.providerContinuation } : {}),
        },
        finishReason: result.finishReason ?? null,
        usage: result.usage,
      };
    }

    const parsedContent = parseAssistantContent(text);
    return {
      kind: "final",
      finalAnswer: parsedContent.content,
      contentParts: parsedContent.parts,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      // 同流式路径：final 轮的思考 continuation 随消息携带。
      assistantMessage: {
        role: "assistant",
        content: parsedContent.content,
        ...(result.reasoningBlocks?.length ? { reasoning_blocks: result.reasoningBlocks } : {}),
        ...(result.providerContinuation ? { provider_continuation: result.providerContinuation } : {}),
      },
      finishReason: result.finishReason ?? null,
      usage: result.usage,
    };
  }

  /** observation -> 消息形态（native 每工具一条 role:"tool" 消息）。 */
  renderObservations(calls: KernelToolCall[], observations: KernelObservation[]): ChatMessage[] {
    const byIndex = new Map<number, KernelObservation>();
    for (const observation of observations) {
      byIndex.set(observation.index, observation);
    }
    const messages: ChatMessage[] = [];
    const imageParts: ContentPart[] = [];
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
      if (Array.isArray(observation.modelContent)) {
        const images = observation.modelContent.filter((part) => part.type === "image_url");
        if (images.length) {
          imageParts.push({ type: "text", text: `Images returned by tool ${call.toolName} (call_id=${call.callId})` }, ...images);
        }
      }
    }
    return imageParts.length ? [...messages, { role: "user", content: imageParts }] : messages;
  }

  /** FC 直传结构化 ChatMessage（厂商模型原生消费）。role:tool 上线前过配对兜底，孤立 observation 不上线。 */
  toModelMessages(messages: ChatMessage[]): ChatMessage[] {
    const rendered: ChatMessage[] = [];
    let deferredImages: ContentPart[] = [];
    const flushImages = (): void => {
      if (!deferredImages.length) return;
      rendered.push({ role: "user", content: deferredImages });
      deferredImages = [];
    };
    for (const message of sanitizeToolPairing(messages).messages) {
      if (message.role !== "tool") {
        flushImages();
        rendered.push(renderNativeModelMessage(message));
        continue;
      }
      if (!Array.isArray(message.content)) {
        rendered.push(renderNativeModelMessage(message));
        continue;
      }
      const images = message.content.filter((part) => part.type === "image_url");
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
      rendered.push(renderNativeModelMessage({ ...message, content: text }));
      if (images.length) {
        deferredImages.push(
          { type: "text", text: `Images returned by tool ${message.name ?? "unknown"} (call_id=${message.tool_call_id ?? "unknown"})` },
          ...images,
        );
      }
    }
    flushImages();
    return rendered;
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

function toChatToolDefinition(tool: RuntimeToolDefinition): ChatToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
    ...(tool.source ? { source: tool.source } : {}),
  };
}

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
