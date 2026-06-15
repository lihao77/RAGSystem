import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../contracts/model-adapter.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  ChatStreamChunkHandler,
  LlmChatClient,
} from "../integrations/llm-chat-client.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
} from "../runtime/runtime-tool-types.js";
import type { AgentPromptContext } from "./agent-prompt-builder.js";
import { buildRuntimeMessages } from "./agent-runtime-core/message-builder.js";
import { executeToolCallRound } from "./agent-runtime-core/tool-round-executor.js";
import {
  buildAssistantToolCallMessage,
  parseToolArguments,
  renderNativeAssistantIntermediateContent,
  toChatToolDefinition,
} from "./agent-runtime-core/tool-call-utils.js";
import {
  parseRuntimeToolCallsXml,
  renderProtocolFeedbackMessage,
  StreamingRuntimeXmlParser,
} from "../runtime/runtime-xml-protocol.js";
import { isAbortError, RuntimeAbortError, throwIfAborted } from "../runtime/abort.js";

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
      type: "runtime.assistant_intermediate";
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
        order: number;
        round_index: number;
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
        raw_result: Record<string, unknown>;
        raw_result_ref: Record<string, unknown>;
        raw_result_available: boolean;
        elapsed_time: number;
        round: number;
        order: number;
        round_index: number;
      };
    }
  | {
      type: "runtime.observation_complete";
      data: {
        content: string;
        agent_name: string;
        round: number;
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
  onModelRequestSuccess?: (() => void | Promise<void>) | undefined;
  toolExecutor?: RuntimeToolExecutor | undefined;
  toolContext?: RuntimeToolExecutionContext | undefined;
  promptContext?: AgentPromptContext | undefined;
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

export interface AgentRuntimeCoreOptions {
  dataRoot?: string | undefined;
}

export class AgentRuntimeCore {
  private readonly dataRoot: string;

  constructor(
    private readonly llmChatClient: LlmChatClient,
    options: AgentRuntimeCoreOptions = {},
  ) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  }

  async runText(input: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    throwIfAborted(input.signal, "Agent run aborted");
    const request = this.buildChatRequest(input);
    try {
      const result = shouldRunXmlToolLoop(input, request, this.llmChatClient)
        ? await this.runXmlToolCallingText(input, request)
        : shouldRunToolLoop(input, request)
        ? await this.runToolCallingText(input, request)
        : this.llmChatClient.stream
          ? await this.runStreamingText(input, request)
          : await this.completeRequest(input, await this.refreshChatRequest(input, request));
      throwIfAborted(input.signal, "Agent run aborted");
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
      if (!input.signal?.aborted && !isAbortError(error)) {
        await input.onEvent?.({
          type: "runtime.error",
          data: {
            message: error instanceof Error ? error.message : String(error),
            agent_name: input.agent.agent_name,
          },
        });
      }
      throw error;
    }
  }

  buildMessages(
    agent: AgentConfig,
    conversation: ChatMessage[],
    options: { xmlProtocolTools?: RuntimeToolDefinition[]; promptContext?: AgentPromptContext } = {},
  ): ChatMessage[] {
    return buildRuntimeMessages(agent, conversation, options);
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

    const maxProtocolRepairAttempts = 2;
    let protocolRepairAttempts = 0;
    let messages = [...request.messages];
    const xmlRequest = withoutNativeTools(request);

    for (let round = 0; ; ) {
      throwIfAborted(input.signal, "Agent run aborted");
      messages = await this.refreshChatMessages(input, messages);
      throwIfAborted(input.signal, "Agent run aborted");
      const roundResult = await this.runXmlStreamRound(input, { ...xmlRequest, messages, allowEmptyStream: true }, round);
      throwIfAborted(input.signal, "Agent run aborted");
      if (roundResult.finishReason === "interrupted") {
        throw new RuntimeAbortError("LLM stream interrupted");
      }
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
        const assistantContent = roundResult.rawContent;
        await input.onEvent?.({
          type: "runtime.assistant_intermediate",
          data: {
            content: assistantContent,
            agent_name: input.agent.agent_name,
            round,
          },
        });
        messages = [...messages, { role: "assistant", content: assistantContent }];
        const roundExecutions = await executeToolCallRound({
          input,
          toolExecutor,
          toolContext,
          dataRoot: this.dataRoot,
          round,
          dependencyAware: true,
          parallelIndependent: true,
          calls: roundResult.toolCalls.map((call, index) => ({
            index,
            callId: call.callId ?? `xml_round_${round}_call_${index + 1}`,
            toolName: call.toolName,
            arguments: call.arguments ?? {},
          })),
        });
        throwIfAborted(input.signal, "Agent run aborted");
        const roundObservationMessages = roundExecutions
          .sort((left, right) => left.index - right.index)
          .map((execution) => execution.observation);
        if (roundObservationMessages.length > 0) {
          const observationContent = roundObservationMessages.join("\n\n");
          messages.push({
            role: "user",
            content: observationContent,
          });
          await input.onEvent?.({
            type: "runtime.observation_complete",
            data: {
              content: observationContent,
              agent_name: input.agent.agent_name,
              round,
            },
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
  }

  private async runToolCallingText(
    input: AgentRuntimeRequest,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResult> {
    const toolExecutor = input.toolExecutor;
    const toolContext = input.toolContext;
    if (!toolExecutor || !toolContext) {
      return this.completeRequest(input, request);
    }

    let messages = [...request.messages];
    for (let round = 0; ; round += 1) {
      throwIfAborted(input.signal, "Agent run aborted");
      messages = await this.refreshChatMessages(input, messages);
      throwIfAborted(input.signal, "Agent run aborted");
      const result = await this.completeRequest(input, { ...request, messages });
      throwIfAborted(input.signal, "Agent run aborted");
      const toolCalls = result.toolCalls ?? [];
      if (toolCalls.length === 0) {
        return result;
      }

      const assistantMessage = buildAssistantToolCallMessage(result, toolCalls);
      await input.onEvent?.({
        type: "runtime.assistant_intermediate",
        data: {
          content: renderNativeAssistantIntermediateContent(result, toolCalls),
          agent_name: input.agent.agent_name,
          round,
        },
      });
      messages = [...messages, assistantMessage];
      const roundExecutions = await executeToolCallRound({
        input,
        toolExecutor,
        toolContext,
        dataRoot: this.dataRoot,
        round,
        dependencyAware: false,
        parallelIndependent: false,
        calls: toolCalls.map((toolCall, index) => ({
          index,
          callId: toolCall.id,
          toolName: toolCall.function.name,
          arguments: parseToolArguments(toolCall),
        })),
      });
      throwIfAborted(input.signal, "Agent run aborted");
      const roundExecutionByIndex = new Map(roundExecutions.map((execution) => [execution.index, execution]));
      for (const [index, toolCall] of toolCalls.entries()) {
        const execution = roundExecutionByIndex.get(index);
        if (!execution) {
          continue;
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: execution.toolName,
          content: execution.observation,
        });
      }
      const observationContent = roundExecutions
        .sort((left, right) => left.index - right.index)
        .map((execution) => execution.observation)
        .join("\n\n");
      if (observationContent.trim()) {
        await input.onEvent?.({
          type: "runtime.observation_complete",
          data: {
            content: observationContent,
            agent_name: input.agent.agent_name,
            round,
          },
        });
      }
    }
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

    const result = await this.streamRequest(input, request, async (chunk) => {
      throwIfAborted(input.signal, "Agent run aborted");
      if (!chunk.content || toolCallsClosed) {
        return toolCallsClosed ? { stop: true } : undefined;
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
      if (toolCallsClosed) {
        return { stop: true };
      }
      if (!protocolTagSeen && parser.currentState === null && events.length === 0 && !chunk.content.trimStart().startsWith("<")) {
        pendingFallbackDeltas.push(chunk.content);
      }
    });
    throwIfAborted(input.signal, "Agent run aborted");

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
    throwIfAborted(input.signal, "Agent run aborted");
    let firstChunkSeen = false;
    const providerStartedAt = Date.now();
    const result = await this.streamRequest(input, refreshedRequest, async (chunk) => {
      throwIfAborted(input.signal, "Agent run aborted");
      if (chunk.finishReason === "interrupted") {
        throw new RuntimeAbortError("LLM stream interrupted");
      }
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
    if (result.finishReason === "interrupted") {
      throw new RuntimeAbortError("LLM stream interrupted");
    }
    return result;
  }

  private async refreshChatMessages(input: AgentRuntimeRequest, messages: ChatMessage[]): Promise<ChatMessage[]> {
    throwIfAborted(input.signal, "Agent run aborted");
    const updates = input.conversationUpdateProvider ? await input.conversationUpdateProvider() : [];
    throwIfAborted(input.signal, "Agent run aborted");
    if (!updates.length) {
      return messages;
    }
    return [...messages, ...updates];
  }

  private async completeRequest(
    input: AgentRuntimeRequest,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResult> {
    const result = await this.llmChatClient.complete(request);
    await input.onModelRequestSuccess?.();
    return result;
  }

  private async streamRequest(
    input: AgentRuntimeRequest,
    request: ChatCompletionRequest,
    onChunk: ChatStreamChunkHandler,
  ): Promise<ChatCompletionResult> {
    const result = await this.llmChatClient.stream!(request, onChunk);
    await input.onModelRequestSuccess?.();
    return result;
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

function withoutNativeTools(request: ChatCompletionRequest): ChatCompletionRequest {
  const { tools: _tools, toolChoice: _toolChoice, ...rest } = request;
  return rest;
}
