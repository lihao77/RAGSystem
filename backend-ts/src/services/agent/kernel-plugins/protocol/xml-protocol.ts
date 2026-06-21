/**
 * Agent 微内核 — 唯一协议（XML 内容协议 + StreamingRuntimeXmlParser）。
 *
 * 来源（逐字迁移，行为零变化）：
 * - buildRequest：吸收 buildChatRequest（L215-242）+ buildMessages（L207-214），
 *   内部应用 withoutNativeTools（L677）——XML 模式下发给模型的请求剥除 native tools 字段，
 *   但 visibleTools 仍用于注入 xmlProtocolTools（system prompt 里的 XML 协议说明）。
 * - invoke：合并 runXmlToolCallingText 外层循环（L257-369，含 maxProtocolRepairAttempts=2
 *   修复重试）+ runXmlStreamRound 流式解析（L446-576）+ runStreamingText 纯流式（L577-616）。
 *   修复重试整段在单次 invoke 内消化，不递增内核 round。
 *   有 tool_calls → 返回 { kind:"tool_calls" }；无 → 自然走纯流式，
 *     返回 { kind:"final" }（无工具是 invoke 的自然结果，不是独立路径）。
 * - renderObservations：对照 L320-337 observation 组装逻辑（XML 单条 user 消息）。
 *
 * 铁律：onChunk 回调里所有 emit 逐字保留（first_token / output_delta / intent_delta 等），
 *   严禁改成"攒完整段再一次性 emit"——会从流式退化成整段炸出。
 *
 * refreshChatMessages（L617-625）属"循环②步补增量"，映射为 MessageRefresher.refresh，
 *   由内核在循环调用；invoke 只读 ctx.messages（已是 refresher 刷新后的工作副本）。
 */

import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatStreamChunkHandler,
  ChatToolCall,
  LlmChatClient,
} from "../../../integrations/llm-chat-client.js";
import type { RuntimeToolCall } from "../../../runtime/runtime-tool-types.js";
import {
  parseRuntimeToolCallsXml,
  renderProtocolFeedbackMessage,
  renderSemanticBlock,
  StreamingRuntimeXmlParser,
} from "../../../runtime/runtime-xml-protocol.js";
import { serializeToolCallsToXml } from "../../../runtime/runtime-xml-protocol/serialize.js";
import { renderSemanticChatMessage } from "../context/message-builder.js";
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
 * 把单条结构化 ChatMessage 渲染成 XML 模型语境（protocol 实例与 monitoring/调试视图共用同一逻辑）。
 * - assistant 带 tool_calls → <intent>content</intent><tool_calls>…</tool_calls>（从结构化字段重建）
 * - role:tool → role:user 透传 observation 文本（observation 已含 <tool_result>；XML 模型不认 role:tool）
 * - 其余（user/assistant final/system）沿用 renderSemanticChatMessage 的语义包装
 */
export function renderXmlModelMessage(message: ChatMessage): ChatMessage {
  if (message.role === "tool") {
    return { role: "user", content: message.content };
  }
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    const intent = message.content ? renderSemanticBlock("intent", message.content) : "";
    return { role: "assistant", content: `${intent}${serializeToolCallsToXml(message.tool_calls)}` };
  }
  return renderSemanticChatMessage(message);
}

/** XML 协议修复重试上限（对齐 L267，maxProtocolRepairAttempts=2）。 */
const MAX_PROTOCOL_REPAIR_ATTEMPTS = 2;

/**
 * XML 内容协议实现。
 *
 * eventSink 由装配注入，invoke 边流边解析时经它发事件（事件类型与 data 字段一字不改）。
 * llmChatClient.stream 在生产恒存在；XML 模式统一走流式（runStreamingText 的纯流式
 * 是 invoke 无 tool_calls 的自然结果）。
 */
export class XmlProtocol implements Protocol {
  constructor(
    private readonly llmChatClient: LlmChatClient,
    private readonly eventSink: EventSink,
  ) {}

  /**
   * 组请求壳（model/provider/temperature/signal）。请求消息由 Context.buildMessages 产出到
   * ctx.requestMessages（内核每轮调用）；visibleTools 探测 + promptContext 合并 + XML 协议
   * 说明注入全在 Context 侧。XML 模式不下发 native tools 字段（等价原 withoutNativeTools）。
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
    // withoutNativeTools（L677）：XML 模式下剥除 native tools 字段。
    // 现状在 buildChatRequest 之后单独 withoutNativeTools(request)；此处直接不写入，
    // 等价（tools/toolChoice 从不进入下发请求）。
    return request;
  }

  /**
   * 问模型 + 边流边解析 + 发 delta + 修复重试（全在单次 invoke 内消化）。
   *
   * 合并 runXmlToolCallingText 外层循环（修复重试）+ runXmlStreamRound（流式解析）+
   * runStreamingText（无 tool_calls 时的纯流式自然结果）。
   */
  /**
   * 唯一分支：客户端支不支持流式。有工具 / 无工具都注入 XML 协议、都走 XML 解析——
   * 无工具是“只有 <final_answer>、没有 <tool_calls>”的特例，不再单列路径。
   *
   * - 有 stream：边流边 XML 解析边发 delta（runXmlStreamRound），含协议修复重试。
   * - 无 stream：complete 拿完整响应后整体 XML 解析（invokeNonStreaming）。
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
   * 流式 invoke：边流边 XML 解析边发 delta + 协议修复重试
   * （合并 runXmlToolCallingText 外层循环，对齐原 L257-369）。
   * stream 由 invoke 收窄后传入，此处不再用 `!` 假设其存在。
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
          renderProtocolFeedbackMessage(
            roundResult.error,
            protocolRepairAttempts,
            MAX_PROTOCOL_REPAIR_ATTEMPTS,
          ),
        ];
        continue;
      }

      protocolRepairAttempts = 0;

      if (roundResult.toolCalls.length > 0) {
        const calls: KernelToolCall[] = roundResult.toolCalls.map((call, index) => ({
          index,
          callId: call.callId ?? `xml_round_${round}_call_${index + 1}`,
          toolName: call.toolName,
          arguments: call.arguments ?? {},
        }));
        // 结构化 assistantMessage：content=intent 正文，tool_calls=结构化字段（与 FC 同形态）。
        // 给 XML 模型回填时由 toModelMessages 序列化回 <intent>…<tool_calls>… XML 文本。
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
        return {
          kind: "tool_calls",
          calls,
          assistantMessage,
          finishReason: roundResult.finishReason,
        };
      }

      const content = roundResult.finalAnswer.trim()
        ? roundResult.finalAnswer
        : roundResult.fallbackAnswer;
      if (content.trim()) {
        return {
          kind: "final",
          finalAnswer: content,
          assistantMessage: { role: "assistant", content },
          finishReason: roundResult.finishReason,
        };
      }

      if (protocolRepairAttempts >= MAX_PROTOCOL_REPAIR_ATTEMPTS) {
        throw new Error("XML protocol repair exceeded max attempts: no final_answer or tool_calls found");
      }
      protocolRepairAttempts += 1;
      messages = [
        ...messages,
        { role: "assistant", content: roundResult.rawContent },
        renderProtocolFeedbackMessage(
          "no final_answer or tool_calls found",
          protocolRepairAttempts,
          MAX_PROTOCOL_REPAIR_ATTEMPTS,
        ),
      ];
    }
  }

  /**
   * 非流式 invoke：client 无 stream 时走 complete，拿完整响应后整体 XML 解析。
   * 不发 first_token / output_delta（非流式无逐字流，结果由内核 done 事件交付）；
   * 不做协议修复重试（非流式无增量解析，失败即抛）。
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
    parser.feed(result.content, { stopAfterClosingTag: "tool_calls" });
    const toolCallsXml = parser.getTagContent("tool_calls");
    if (toolCallsXml.trim()) {
      const parsed = parseRuntimeToolCallsXml(toolCallsXml);
      if (parsed.calls.length > 0) {
        const calls: KernelToolCall[] = parsed.calls.map((call, index) => ({
          index,
          callId: call.callId ?? `xml_round_${round}_call_${index + 1}`,
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
        };
      }
    }
    const finalAnswer = parser.getTagContent("final_answer");
    const content = finalAnswer.trim() ? finalAnswer : result.content;
    return {
      kind: "final",
      finalAnswer: content,
      assistantMessage: { role: "assistant", content },
      finishReason: result.finishReason ?? null,
    };
  }

  /**
   * observation → 消息形态（XML 单条 user），对照 L320-337 逐字迁移。
   *
   * 现状在 runXmlToolCallingText 内部组装 roundObservationMessages：按 index 排序后
   * join("\n\n") 成单条 user 消息回喂模型，并在此 emit runtime.observation_complete。
   *
   * 注意边界（计划第六节）：observation_complete 事件归宿是"写消息表（addMessage）"，
   * 与 observation 消息回喂模型是两件事。但现状 runXmlToolCallingText 在 push user 消息的
   * 同一时刻 emit 了 observation_complete——该事件携带的是合并后的 observationContent。
   * 本方法只产消息形态（renderObservations 契约职责），observation_complete 事件的
   * 发射时机交给内核/装配层在 appendMessages 后处理，避免协议越界直连 EventSink 落库。
   * 见下方"需上层注意"。
   */
  renderObservations(
    calls: KernelToolCall[],
    observations: KernelObservation[],
  ): ChatMessage[] {
    // 与 NativeHybridProtocol 同形态：每工具一条 role:tool + tool_call_id 结构化消息。
    // 给 XML 模型回填时由 toModelMessages 转成 role:user + <tool_result>（XML 模型不认 role:tool）。
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
   * 把结构化 ChatMessage[] 序列化成 XML 模型语境（物理边界）。
   * 见模块级 renderXmlModelMessage（protocol 实例与 monitoring/调试视图共用同一渲染逻辑）。
   */
  toModelMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map(renderXmlModelMessage);
  }

  /**
   * 单轮流式解析（逐字迁 runXmlStreamRound L446-576）。
   *
   * onChunk 回调里所有 emit 经 this.eventSink.emit 发出，事件类型与 data 字段一字不改。
   * 边流边解析：解析出 final_answer 片段立即 emit output_delta（实时通道），
   * 同时累积 finalAnswer（结果通道）。严禁改成攒完整段再 emit。
   */
  private async runXmlStreamRound(
    ctx: KernelContext,
    request: ChatCompletionRequest,
    round: number,
    stream: (
      request: ChatCompletionRequest,
      onChunk: ChatStreamChunkHandler,
    ) => Promise<ChatCompletionResult>,
  ): Promise<{
    rawContent: string;
    intent: string;
    finalAnswer: string;
    fallbackAnswer: string;
    toolCalls: RuntimeToolCall[];
    finishReason: string | null;
    error: string | null;
  }> {
    const session = ctx.session;
    const agentName = session.agent.agent_name;
    const signal = session.signal;

    const parser = new StreamingRuntimeXmlParser();
    let firstChunkSeen = false;
    const providerStartedAt = Date.now();
    let intent = "";
    let finalAnswer = "";
    let toolCallsClosed = false;
    let finalAnswerStarted = false;
    let ignoredToolCallsAfterFinal = false;
    let error: string | null = null;
    let protocolTagSeen = false;
    const pendingFallbackDeltas: string[] = [];
    const toolCalls: RuntimeToolCall[] = [];

    const result = await stream(request, async (chunk) => {
      throwIfAborted(signal, "Agent run aborted");
      if (!chunk.content || toolCallsClosed) {
        return toolCallsClosed ? { stop: true } : undefined;
      }
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
      const events = parser.feed(chunk.content, { stopAfterClosingTag: "tool_calls" });
      for (const event of events) {
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
          this.eventSink.emit({
            type: "runtime.intent_delta",
            data: {
              content: event.content,
              agent_name: agentName,
              round,
            },
          });
        }
        if (event.type === "content" && event.tag === "final_answer" && !toolCallsClosed) {
          finalAnswer += event.content;
          this.eventSink.emit({
            type: "runtime.output_delta",
            data: {
              content: event.content,
              agent_name: agentName,
            },
          });
        }
        if (event.type === "tag_close" && event.tag === "intent") {
          this.eventSink.emit({
            type: "runtime.intent_complete",
            data: {
              content: intent,
              agent_name: agentName,
              round,
            },
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
      if (
        !protocolTagSeen &&
        parser.currentState === null &&
        events.length === 0 &&
        !chunk.content.trimStart().startsWith("<")
      ) {
        pendingFallbackDeltas.push(chunk.content);
      }
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
      // 纯流式回退：模型未用 XML 协议标签，逐字补发积压的 delta（对齐 L555-565）。
      for (const content of pendingFallbackDeltas) {
        this.eventSink.emit({
          type: "runtime.output_delta",
          data: {
            content,
            agent_name: agentName,
          },
        });
      }
    }
    const fallbackAnswer = sawProtocolTag ? "" : rawContent;
    return {
      rawContent,
      intent: parser.getTagContent("intent"),
      finalAnswer,
      fallbackAnswer,
      toolCalls,
      finishReason: result.finishReason ?? null,
      error,
    };
  }

}
