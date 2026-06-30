/**
 * Native Hybrid 协议实现（迁自 backend-ts native-hybrid-protocol.ts）。
 *
 * 混合形态：工具调用走厂商原生 FC（结构化 chunk.toolCalls），content 走 StreamingRuntimeXmlParser
 * 解析 <intent>/<final_answer>，补齐 XmlProtocol 才有的 intent 事件链。
 * - buildRequestShell 保留 native tools：写入 request.tools（toChatToolDefinition）+ toolChoice:"auto"。
 * - renderObservations 产 role:"tool" 消息（每工具一条，tool_call_id 关联）。
 * - 无协议修复重试：native 工具是结构化输出不存在"标签没闭合"。
 *
 * content 弱约束 fallback：模型未用任何协议标签、直接吐纯文本时，缓存原始 delta，流末补发为
 * output_delta 并当 final_answer。
 *
 * 与 backend-ts 差异（同 XmlProtocol）：LlmClient/LlmRequest、readTierParams、扁平 KernelEvent。
 * visibleTools 来源从 session.toolExecutor 改为 deps.getTools()（SDK 工具端口尚未接入，默认空）。
 */
import type { ChatMessage, ChatToolCall, ChatToolDefinition, LlmClient, LlmRequest, LlmStreamHandler, ProviderConfig } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";
import { RuntimeAbortError, throwIfAborted } from "@ragsystem/agent-protocol";
import type { EventSink, KernelContext, KernelObservation, KernelOutcome, KernelToolCall, Protocol } from "../contracts.js";
import { readTierParams } from "../llm-params/index.js";
import type { RuntimeToolDefinition } from "../prompt/tool-types.js";
import { renderNativeXmlProtocolInstruction, StreamingRuntimeXmlParser } from "./xml/index.js";
import { renderNativeModelMessage } from "./message-rendering.js";

/** NativeHybridProtocol 构造依赖。 */
export interface NativeHybridProtocolDeps {
  llm: LlmClient;
  events: EventSink;
  getTools: () => RuntimeToolDefinition[];
}

export class NativeHybridProtocol implements Protocol {
  constructor(private readonly deps: NativeHybridProtocolDeps) {}

  async invoke(ctx: KernelContext, round: number): Promise<KernelOutcome> {
    const baseRequest = this.buildRequest(ctx);
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

  /** 流式 invoke：content 走 XML 解析（intent/final_answer 逐字 emit），toolCalls 走 FC 结构化字段。 */
  private async invokeStreaming(
    ctx: KernelContext,
    baseRequest: LlmRequest,
    round: number,
    stream: (request: LlmRequest, onChunk: LlmStreamHandler) => Promise<{ content: string; toolCalls?: ChatToolCall[]; finishReason?: string | null }>,
  ): Promise<KernelOutcome> {
    const session = ctx.session;
    const agentName = session.profile.agentName;
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
      if (chunk.toolCalls && chunk.toolCalls.length > 0) {
        toolCalls.push(...chunk.toolCalls);
      }
      if (!chunk.content) {
        return undefined;
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        this.deps.events.emit({ type: "first_token", agentName, elapsedMs: Date.now() - providerStartedAt });
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
          this.deps.events.emit({ type: "intent_delta", agentName, content: event.content, round });
        }
        if (event.type === "content" && event.tag === "final_answer") {
          finalAnswer += event.content;
          this.deps.events.emit({ type: "output_delta", agentName, content: event.content });
        }
        if (event.type === "tag_close" && event.tag === "intent") {
          this.deps.events.emit({ type: "intent_complete", agentName, content: intent, round });
        }
      }
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
      for (const content of pendingFallbackDeltas) {
        this.deps.events.emit({ type: "output_delta", agentName, content });
      }
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
        content: parser.getTagContent("intent"),
        tool_calls: toolCalls,
      };
      return { kind: "tool_calls", calls, assistantMessage, finishReason: result.finishReason ?? null };
    }

    const rawContent = parser.getFullResponse() || result.content || "";
    return {
      kind: "final",
      finalAnswer: finalAnswer.trim() ? finalAnswer : rawContent,
      assistantMessage: { role: "assistant", content: finalAnswer.trim() ? finalAnswer : rawContent },
      finishReason: result.finishReason ?? null,
    };
  }

  /** 非流式 invoke：complete 拿完整响应后整体 XML 解析。content 弱约束：解析出 <final_answer> 用之，否则原始 content 兜底。 */
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
    const finalAnswer = parser.getTagContent("final_answer");
    const content = finalAnswer.trim() ? finalAnswer : result.content || "";

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

  /** observation -> 消息形态（native 每工具一条 role:"tool" 消息）。 */
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
        content: observation.observation,
      });
    }
    return messages;
  }

  /** FC 直传结构化 ChatMessage（厂商模型原生消费）。 */
  toModelMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(renderNativeModelMessage);
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
