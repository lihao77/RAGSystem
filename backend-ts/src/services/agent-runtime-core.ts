import type { AgentConfig } from "../contracts/agent-config.js";
import type { ModelProviderConfig } from "../contracts/model-adapter.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  LlmChatClient,
} from "./llm-chat-client.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
} from "./runtime-tool-types.js";
import type { ToolExecutionResult } from "./memory-tool-service.js";
import { buildFullSystemPrompt, type AgentPromptContext } from "./agent-prompt-builder.js";
import {
  isSemanticTaggedContent,
  parseRuntimeToolCallsXml,
  renderProtocolFeedbackMessage,
  renderRuntimeXmlProtocolInstruction,
  renderSemanticBlock,
  renderToolResultContent,
  StreamingRuntimeXmlParser,
} from "./runtime-xml-protocol.js";

export type AgentRuntimeEvent =
  | {
      type: "runtime.first_token";
      data: {
        elapsed_ms: number;
        agent_name: string;
      };
    }
  | {
      type: "runtime.output_delta";
      data: {
        content: string;
        agent_name: string;
      };
    }
  | {
      type: "runtime.intent_delta";
      data: {
        content: string;
        agent_name: string;
        round: number;
      };
    }
  | {
      type: "runtime.intent_complete";
      data: {
        content: string;
        agent_name: string;
        round: number;
      };
    }
  | {
      type: "runtime.done";
      data: {
        content: string;
        agent_name: string;
        finish_reason: string | null;
      };
    }
  | {
      type: "runtime.tool_call";
      data: {
        agent_name: string;
        tool_call_id: string;
        tool_name: string;
        arguments: Record<string, unknown>;
        round: number;
      };
    }
  | {
      type: "runtime.tool_result";
      data: {
        agent_name: string;
        tool_call_id: string;
        tool_name: string;
        success: boolean;
        summary: string;
        observation: string;
        metadata: Record<string, unknown>;
      };
    }
  | {
      type: "runtime.error";
      data: {
        message: string;
        agent_name: string;
      };
    };

export type AgentRuntimeEventHandler = (event: AgentRuntimeEvent) => void | Promise<void>;

export interface AgentRuntimeRequest {
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName: string;
  conversation: ChatMessage[];
  conversationUpdateProvider?: (() => Promise<ChatMessage[]> | ChatMessage[]) | undefined;
  signal?: AbortSignal;
  onEvent?: AgentRuntimeEventHandler;
  toolExecutor?: RuntimeToolExecutor | undefined;
  toolContext?: RuntimeToolExecutionContext | undefined;
  promptContext?: AgentPromptContext | undefined;
  maxToolRounds?: number | undefined;
}

export interface AgentRuntimeResult {
  content: string;
  raw?: unknown;
  finish_reason: string | null;
  metadata: {
    agent_name: string;
    provider_key: string | null;
    provider_type: string;
    model_name: string;
  };
}

export class AgentRuntimeCore {
  constructor(private readonly llmChatClient: LlmChatClient) {}

  async runText(input: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const request = this.buildChatRequest(input);
    try {
      const result = shouldRunXmlToolLoop(input, request, this.llmChatClient)
        ? await this.runXmlToolCallingText(input, request)
        : shouldRunToolLoop(input, request)
        ? await this.runToolCallingText(input, request)
        : this.llmChatClient.stream
          ? await this.runStreamingText(input, request)
          : await this.llmChatClient.complete(await this.refreshChatRequest(input, request));
      const runtimeResult = toRuntimeResult(input, result);
      await input.onEvent?.({
        type: "runtime.done",
        data: {
          content: runtimeResult.content,
          agent_name: input.agent.agent_name,
          finish_reason: runtimeResult.finish_reason,
        },
      });
      return runtimeResult;
    } catch (error) {
      await input.onEvent?.({
        type: "runtime.error",
        data: {
          message: error instanceof Error ? error.message : String(error),
          agent_name: input.agent.agent_name,
        },
      });
      throw error;
    }
  }

  buildMessages(
    agent: AgentConfig,
    conversation: ChatMessage[],
    options: { xmlProtocolTools?: RuntimeToolDefinition[]; promptContext?: AgentPromptContext } = {},
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const systemParts: string[] = [];
    const systemPrompt = buildFullSystemPrompt(agent, options.promptContext);
    if (systemPrompt) {
      systemParts.push(renderSemanticBlock("system_instruction", systemPrompt, { source: "agent_config" }));
    }
    let conversationIndex = 0;
    while (conversation[conversationIndex]?.role === "system") {
      const content = conversation[conversationIndex]?.content.trim();
      if (content) {
        systemParts.push(renderSystemContextBlock(content));
      }
      conversationIndex += 1;
    }
    if (options.xmlProtocolTools?.length) {
      systemParts.push(renderRuntimeXmlProtocolInstruction(options.xmlProtocolTools));
    }
    if (systemParts.length > 0) {
      messages.push({ role: "system", content: systemParts.join("\n\n") });
    }
    messages.push(...conversation.slice(conversationIndex).map((message) => renderSemanticChatMessage(message)));
    return messages;
  }

  private buildChatRequest(input: AgentRuntimeRequest): ChatCompletionRequest {
    const visibleTools =
      input.toolExecutor && input.toolContext ? input.toolExecutor.listVisibleTools(input.agent) : [];
    const promptContext = {
      ...(input.promptContext ?? {}),
      tools: input.promptContext?.tools ?? visibleTools,
    };
    const request: ChatCompletionRequest = {
      messages: this.buildMessages(input.agent, input.conversation, {
        xmlProtocolTools: visibleTools,
        promptContext,
      }),
      model: input.modelName,
      provider: input.provider,
      agent: input.agent,
      temperature: input.agent.llm_tiers?.default?.temperature ?? null,
      maxCompletionTokens: input.agent.llm_tiers?.default?.max_completion_tokens ?? null,
    };
    if (visibleTools.length > 0) {
      request.tools = visibleTools.map(toChatToolDefinition);
      request.toolChoice = "auto";
    }
    if (input.signal) {
      request.signal = input.signal;
    }
    return request;
  }

  private async refreshChatRequest(
    input: AgentRuntimeRequest,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionRequest> {
    const updates = input.conversationUpdateProvider ? await input.conversationUpdateProvider() : [];
    if (!updates.length) {
      return request;
    }
    return {
      ...request,
      messages: [...request.messages, ...updates],
    };
  }

  private async runXmlToolCallingText(
    input: AgentRuntimeRequest,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResult> {
    const toolExecutor = input.toolExecutor;
    const toolContext = input.toolContext;
    if (!toolExecutor || !toolContext || !this.llmChatClient.stream) {
      return this.runToolCallingText(input, request);
    }

    const maxToolRounds = input.maxToolRounds ?? 4;
    const maxProtocolRepairAttempts = 2;
    let protocolRepairAttempts = 0;
    let messages = [...request.messages];
    const xmlRequest = withoutNativeTools(request);

    for (let round = 0; round <= maxToolRounds; ) {
      messages = await this.refreshChatMessages(input, messages);
      const roundResult = await this.runXmlStreamRound(input, { ...xmlRequest, messages }, round);
      if (roundResult.error) {
        if (protocolRepairAttempts >= maxProtocolRepairAttempts) {
          throw new Error(`XML protocol repair exceeded max attempts: ${roundResult.error}`);
        }
        protocolRepairAttempts += 1;
        messages = [
          ...messages,
          { role: "assistant", content: roundResult.rawContent },
          renderProtocolFeedbackMessage(roundResult.error, protocolRepairAttempts, maxProtocolRepairAttempts),
        ];
        continue;
      }

      protocolRepairAttempts = 0;
      if (roundResult.toolCalls.length > 0) {
        if (round === maxToolRounds) {
          throw new Error(`Tool calling exceeded max rounds (${maxToolRounds})`);
        }

        messages = [...messages, { role: "assistant", content: roundResult.rawContent }];
        const roundResults = new Map<number, ToolExecutionResult>();
        const roundObservationMessages: string[] = [];
        for (const [index, call] of roundResult.toolCalls.entries()) {
          const toolName = call.toolName;
          const callId = call.callId ?? `xml_round_${round}_call_${index + 1}`;
          const toolArguments = resolveToolArgumentReferences(call.arguments ?? {}, roundResults);
          await input.onEvent?.({
            type: "runtime.tool_call",
            data: {
              agent_name: input.agent.agent_name,
              tool_call_id: callId,
              tool_name: toolName,
              arguments: toolArguments,
              round,
            },
          });
          const unresolvedPlaceholders = collectResultPlaceholders(toolArguments);
          const toolResult = unresolvedPlaceholders.length
            ? buildToolReferenceErrorResult(toolName, unresolvedPlaceholders)
            : await toolExecutor.executeTool(
                {
                  toolName,
                  arguments: toolArguments,
                  callId,
                },
                buildToolCallExecutionContext(toolContext, { callId, round, index }),
              );
          roundResults.set(index + 1, toolResult);
          await input.onEvent?.({
            type: "runtime.tool_result",
            data: {
              agent_name: input.agent.agent_name,
              tool_call_id: callId,
              tool_name: toolName,
              success: toolResult.success,
              summary: toolResult.summary,
              observation: renderToolResultContent({ callId, toolName, result: toolResult }),
              metadata: toolResult.metadata,
            },
          });
          roundObservationMessages.push(renderToolResultContent({ callId, toolName, result: toolResult }));
        }
        if (roundObservationMessages.length > 0) {
          messages.push({
            role: "user",
            content: roundObservationMessages.join("\n\n"),
          });
        }
        round += 1;
        continue;
      }

      const content = roundResult.finalAnswer.trim() ? roundResult.finalAnswer : roundResult.fallbackAnswer;
      if (content.trim()) {
        return {
          content,
          raw: {
            protocol: "xml",
            raw_content: roundResult.rawContent,
          },
          finishReason: roundResult.finishReason,
        };
      }

      if (protocolRepairAttempts >= maxProtocolRepairAttempts) {
        throw new Error("XML protocol repair exceeded max attempts: no final_answer or tool_calls found");
      }
      protocolRepairAttempts += 1;
      messages = [
        ...messages,
        { role: "assistant", content: roundResult.rawContent },
        renderProtocolFeedbackMessage(
          "no final_answer or tool_calls found",
          protocolRepairAttempts,
          maxProtocolRepairAttempts,
        ),
      ];
    }

    throw new Error(`Tool calling exceeded max rounds (${maxToolRounds})`);
  }

  private async runToolCallingText(
    input: AgentRuntimeRequest,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResult> {
    const toolExecutor = input.toolExecutor;
    const toolContext = input.toolContext;
    if (!toolExecutor || !toolContext) {
      return this.llmChatClient.complete(request);
    }

    const maxToolRounds = input.maxToolRounds ?? 4;
    let messages = [...request.messages];
    for (let round = 0; round <= maxToolRounds; round += 1) {
      messages = await this.refreshChatMessages(input, messages);
      const result = await this.llmChatClient.complete({ ...request, messages });
      const toolCalls = result.toolCalls ?? [];
      if (toolCalls.length === 0) {
        return result;
      }
      if (round === maxToolRounds) {
        throw new Error(`Tool calling exceeded max rounds (${maxToolRounds})`);
      }

      messages = [...messages, buildAssistantToolCallMessage(result, toolCalls)];
      const roundResults = new Map<number, ToolExecutionResult>();
      for (const [index, toolCall] of toolCalls.entries()) {
        const toolName = toolCall.function.name;
        const toolArguments = resolveToolArgumentReferences(parseToolArguments(toolCall), roundResults);
        await input.onEvent?.({
          type: "runtime.tool_call",
          data: {
            agent_name: input.agent.agent_name,
            tool_call_id: toolCall.id,
            tool_name: toolName,
            arguments: toolArguments,
            round,
          },
        });
        const unresolvedPlaceholders = collectResultPlaceholders(toolArguments);
        const toolResult = unresolvedPlaceholders.length
          ? buildToolReferenceErrorResult(toolName, unresolvedPlaceholders)
          : await toolExecutor.executeTool(
              {
                toolName,
                arguments: toolArguments,
                callId: toolCall.id,
              },
              buildToolCallExecutionContext(toolContext, { callId: toolCall.id, round, index }),
            );
        roundResults.set(index + 1, toolResult);
        await input.onEvent?.({
          type: "runtime.tool_result",
          data: {
            agent_name: input.agent.agent_name,
            tool_call_id: toolCall.id,
            tool_name: toolName,
            success: toolResult.success,
            summary: toolResult.summary,
            observation: renderToolResultContent({ callId: toolCall.id, toolName, result: toolResult }),
            metadata: toolResult.metadata,
          },
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: renderToolResultContent({
            callId: toolCall.id,
            toolName,
            result: toolResult,
          }),
        });
      }
    }
    throw new Error(`Tool calling exceeded max rounds (${maxToolRounds})`);
  }

  private async runXmlStreamRound(
    input: AgentRuntimeRequest,
    request: ChatCompletionRequest,
    round: number,
  ): Promise<{
    rawContent: string;
    finalAnswer: string;
    fallbackAnswer: string;
    toolCalls: RuntimeToolCall[];
    finishReason: string | null;
    error: string | null;
  }> {
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

    const result = await this.llmChatClient.stream!(request, async (chunk) => {
      if (!chunk.content) {
        return;
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        await input.onEvent?.({
          type: "runtime.first_token",
          data: {
            elapsed_ms: Date.now() - providerStartedAt,
            agent_name: input.agent.agent_name,
          },
        });
      }
      const events = parser.feed(chunk.content);
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
          await input.onEvent?.({
            type: "runtime.intent_delta",
            data: {
              content: event.content,
              agent_name: input.agent.agent_name,
              round,
            },
          });
        }
        if (event.type === "content" && event.tag === "final_answer" && !toolCallsClosed) {
          finalAnswer += event.content;
          await input.onEvent?.({
            type: "runtime.output_delta",
            data: {
              content: event.content,
              agent_name: input.agent.agent_name,
            },
          });
        }
        if (event.type === "tag_close" && event.tag === "intent") {
          await input.onEvent?.({
            type: "runtime.intent_complete",
            data: {
              content: intent,
              agent_name: input.agent.agent_name,
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
      if (!protocolTagSeen && parser.currentState === null && events.length === 0 && !chunk.content.trimStart().startsWith("<")) {
        pendingFallbackDeltas.push(chunk.content);
      }
    });

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
        await input.onEvent?.({
          type: "runtime.output_delta",
          data: {
            content,
            agent_name: input.agent.agent_name,
          },
        });
      }
    }
    const fallbackAnswer = sawProtocolTag ? "" : rawContent;
    return {
      rawContent,
      finalAnswer,
      fallbackAnswer,
      toolCalls,
      finishReason: result.finishReason ?? null,
      error,
    };
  }

  private async runStreamingText(
    input: AgentRuntimeRequest,
    request: ChatCompletionRequest,
  ): Promise<{ content: string; raw?: unknown }> {
    const refreshedRequest = await this.refreshChatRequest(input, request);
    let firstChunkSeen = false;
    const providerStartedAt = Date.now();
    return this.llmChatClient.stream!(refreshedRequest, async (chunk) => {
      if (!chunk.content) {
        return;
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        await input.onEvent?.({
          type: "runtime.first_token",
          data: {
            elapsed_ms: Date.now() - providerStartedAt,
            agent_name: input.agent.agent_name,
          },
        });
      }
      await input.onEvent?.({
        type: "runtime.output_delta",
        data: {
          content: chunk.content,
          agent_name: input.agent.agent_name,
        },
      });
    });
  }

  private async refreshChatMessages(input: AgentRuntimeRequest, messages: ChatMessage[]): Promise<ChatMessage[]> {
    const updates = input.conversationUpdateProvider ? await input.conversationUpdateProvider() : [];
    if (!updates.length) {
      return messages;
    }
    return [...messages, ...updates];
  }
}

function shouldRunToolLoop(input: AgentRuntimeRequest, request: ChatCompletionRequest): boolean {
  return Boolean(input.toolExecutor && input.toolContext && request.tools?.length);
}

function shouldRunXmlToolLoop(
  input: AgentRuntimeRequest,
  request: ChatCompletionRequest,
  llmChatClient: LlmChatClient,
): boolean {
  return shouldRunToolLoop(input, request) && Boolean(llmChatClient.stream);
}

function toRuntimeResult(input: AgentRuntimeRequest, result: ChatCompletionResult): AgentRuntimeResult {
  const runtimeResult: AgentRuntimeResult = {
    content: result.content,
    finish_reason: result.finishReason ?? null,
    metadata: {
      agent_name: input.agent.agent_name,
      provider_key: input.provider.key ?? null,
      provider_type: input.provider.provider_type,
      model_name: input.modelName,
    },
  };
  if (result.raw !== undefined) {
    runtimeResult.raw = result.raw;
  }
  return runtimeResult;
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

function buildAssistantToolCallMessage(result: ChatCompletionResult, toolCalls: ChatToolCall[]): ChatMessage {
  return {
    role: "assistant",
    content: result.content,
    tool_calls: toolCalls,
  };
}

function withoutNativeTools(request: ChatCompletionRequest): ChatCompletionRequest {
  const { tools: _tools, toolChoice: _toolChoice, ...rest } = request;
  return rest;
}

function buildToolCallExecutionContext(
  context: RuntimeToolExecutionContext,
  input: {
    callId: string;
    round: number;
    index: number;
  },
): RuntimeToolExecutionContext {
  const order = input.index + 1;
  return {
    ...context,
    toolCallId: input.callId,
    round: input.round,
    order,
    roundIndex: order,
  };
}

function renderSystemContextBlock(content: string): string {
  if (isSemanticTaggedContent(content)) {
    return content;
  }
  if (content.includes("[Memory Scope Capabilities]") || content.includes("Memory Index]")) {
    return renderSemanticBlock("context", content, { source: "memory" });
  }
  return renderSemanticBlock("runtime_instruction", content, { source: "runtime_context" });
}

function renderSemanticChatMessage(message: ChatMessage): ChatMessage {
  if (isSemanticTaggedContent(message.content)) {
    return { ...message };
  }
  if (message.role === "user") {
    return {
      ...message,
      content: renderSemanticBlock("user_input", message.content, { source: "conversation" }),
    };
  }
  if (message.role === "assistant") {
    return {
      ...message,
      content: renderSemanticBlock("assistant_final", message.content, { source: "conversation" }),
    };
  }
  if (message.role === "tool") {
    return {
      ...message,
      content: renderSemanticBlock("tool_result", message.content, {
        source: "native_tool_message",
        call_id: message.tool_call_id ?? "",
        name: message.name ?? "",
      }),
    };
  }
  return { ...message, content: renderSystemContextBlock(message.content) };
}

function parseToolArguments(toolCall: ChatToolCall): Record<string, unknown> {
  const raw = toolCall.function.arguments.trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return {
      _raw_arguments: raw,
    };
  }
}

const RESULT_REFERENCE_PATTERN = /\{result_?(\d+)(?:\.([A-Za-z0-9_.]+))?\}/gi;
const EXACT_RESULT_REFERENCE_PATTERN = /^\{result_?(\d+)(?:\.([A-Za-z0-9_.]+))?\}$/i;

function resolveToolArgumentReferences(
  value: Record<string, unknown>,
  results: Map<number, ToolExecutionResult>,
): Record<string, unknown> {
  const resolved = resolveReferenceValue(value, results);
  return isRecord(resolved) ? resolved : value;
}

function resolveReferenceValue(value: unknown, results: Map<number, ToolExecutionResult>): unknown {
  if (typeof value === "string") {
    return resolveReferenceString(value, results);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveReferenceValue(item, results));
  }
  if (isRecord(value)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      resolved[key] = resolveReferenceValue(item, results);
    }
    return resolved;
  }
  return value;
}

function resolveReferenceString(value: string, results: Map<number, ToolExecutionResult>): unknown {
  const exact = EXACT_RESULT_REFERENCE_PATTERN.exec(value);
  if (exact) {
    const reference = resolveReferenceMatch(exact, results);
    return reference.resolved ? reference.value : value;
  }

  RESULT_REFERENCE_PATTERN.lastIndex = 0;
  return value.replace(RESULT_REFERENCE_PATTERN, (placeholder, rawIndex: string, path: string | undefined) => {
    const reference = resolveResultReference(Number.parseInt(rawIndex, 10), path ?? null, results, placeholder);
    return reference.resolved ? stringifyReferenceValue(reference.value) : placeholder;
  });
}

function resolveReferenceMatch(
  match: RegExpExecArray,
  results: Map<number, ToolExecutionResult>,
): { resolved: true; value: unknown } | { resolved: false } {
  const rawIndex = match[1];
  if (!rawIndex) {
    return { resolved: false };
  }
  return resolveResultReference(Number.parseInt(rawIndex, 10), match[2] ?? null, results, match[0]);
}

function resolveResultReference(
  index: number,
  path: string | null,
  results: Map<number, ToolExecutionResult>,
  placeholder: string,
): { resolved: true; value: unknown } | { resolved: false } {
  const result = results.get(index);
  if (!result) {
    return { resolved: false };
  }
  if (!path) {
    return { resolved: true, value: result.content };
  }

  const materialized = materializeToolResult(result);
  const resolved = resolveDottedPath(materialized, path, true);
  if (resolved.found) {
    return { resolved: true, value: resolved.value };
  }
  if ("content" in materialized) {
    const contentResolved = resolveDottedPath(materialized.content, path, true);
    if (contentResolved.found) {
      return { resolved: true, value: contentResolved.value };
    }
  }
  return {
    resolved: true,
    value: {
      __ref_error__: "path_not_found",
      placeholder,
      available_keys: collectAvailableKeys(materialized, path),
    },
  };
}

function materializeToolResult(result: ToolExecutionResult): Record<string, unknown> {
  return {
    success: result.success,
    tool_name: result.tool_name,
    summary: result.summary,
    answer: result.answer,
    output_type: result.output_type,
    content: result.content,
    metadata: result.metadata,
    artifacts: result.artifacts,
    ...(result.success ? {} : { error: stringifyReferenceValue(result.content) || result.summary }),
  };
}

function resolveDottedPath(
  value: unknown,
  dottedPath: string,
  caseInsensitive: boolean,
): { found: true; value: unknown } | { found: false } {
  let current = value;
  for (const rawKey of dottedPath.split(".")) {
    if (isRecord(current)) {
      if (rawKey in current) {
        current = current[rawKey];
        continue;
      }
      if (caseInsensitive) {
        const lowered = rawKey.toLowerCase();
        const matchedKey = Object.keys(current).find((key) => key.toLowerCase() === lowered);
        if (matchedKey !== undefined) {
          current = current[matchedKey];
          continue;
        }
      }
      return { found: false };
    }
    if (Array.isArray(current)) {
      const index = Number.parseInt(rawKey, 10);
      if (Number.isInteger(index) && index >= 0 && index < current.length) {
        current = current[index];
        continue;
      }
      return { found: false };
    }
    return { found: false };
  }
  return { found: true, value: current };
}

function collectAvailableKeys(value: unknown, dottedPath: string): string[] {
  let current = value;
  for (const rawKey of dottedPath.split(".")) {
    if (isRecord(current)) {
      if (rawKey in current) {
        current = current[rawKey];
        continue;
      }
      return Object.keys(current).slice(0, 10);
    }
    if (Array.isArray(current)) {
      const index = Number.parseInt(rawKey, 10);
      if (Number.isInteger(index) && index >= 0 && index < current.length) {
        current = current[index];
        continue;
      }
      return [`list(len=${current.length})`];
    }
    return [`type=${typeof current}`];
  }
  return [];
}

function stringifyReferenceValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectResultPlaceholders(value: unknown): string[] {
  const found: string[] = [];
  const scan = (item: unknown): void => {
    if (typeof item === "string") {
      RESULT_REFERENCE_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = RESULT_REFERENCE_PATTERN.exec(item)) !== null) {
        found.push(match[0]);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        scan(child);
      }
      return;
    }
    if (isRecord(item)) {
      for (const child of Object.values(item)) {
        scan(child);
      }
    }
  };
  scan(value);
  return Array.from(new Set(found));
}

function buildToolReferenceErrorResult(toolName: string, placeholders: string[]): ToolExecutionResult<string> {
  const summary = `参数中包含未替换的占位符: ${placeholders.join(", ")}，请检查引用路径是否正确`;
  return {
    success: false,
    tool_name: toolName,
    summary,
    answer: null,
    output_type: "error",
    content: summary,
    metadata: {
      source_shape: "error",
      unresolved_placeholders: placeholders,
    },
    artifacts: [],
    llm_hint: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
