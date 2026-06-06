import os from "node:os";
import path from "node:path";

import type { AgentConfig } from "../contracts/agent-config.js";
import type { ModelProviderConfig } from "../contracts/model-adapter.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  LlmChatClient,
} from "./llm-chat-client.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
  RuntimeToolWaitResult,
} from "./runtime-tool-types.js";
import type { ToolExecutionResult } from "./memory-tool-service.js";
import type { AgentPromptContext } from "./agent-prompt-builder.js";
import { buildRuntimeMessages } from "./agent-runtime-core/message-builder.js";
import { buildLlmFacingToolResult } from "./agent-runtime-core/observation.js";
import {
  buildAssistantToolCallMessage,
  buildToolExecutionErrorResult,
  buildToolReferenceErrorResult,
  collectResultPlaceholders,
  collectResultReferenceIndexes,
  materializeToolResult,
  parseToolArguments,
  renderNativeAssistantIntermediateContent,
  resolveToolArgumentReferences,
  toChatToolDefinition,
} from "./agent-runtime-core/tool-call-utils.js";
import {
  parseRuntimeToolCallsXml,
  renderProtocolFeedbackMessage,
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
        const roundExecutions = await this.executeToolCallRound({
          input,
          toolExecutor,
          toolContext,
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
      const roundExecutions = await this.executeToolCallRound({
        input,
        toolExecutor,
        toolContext,
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

  private async executeToolCallRound(input: {
    input: AgentRuntimeRequest;
    toolExecutor: RuntimeToolExecutor;
    toolContext: RuntimeToolExecutionContext;
    round: number;
    dependencyAware: boolean;
    parallelIndependent: boolean;
    calls: PreparedRoundToolCall[];
  }): Promise<RuntimeToolRoundExecution[]> {
    const roundResults = new Map<number, ToolExecutionResult>();
    const executions = new Map<number, RuntimeToolRoundExecution>();
    const batches = input.dependencyAware
      ? buildExecutionBatches(input.calls)
      : input.calls.map((call) => [call]);
    for (const batch of batches) {
      const runCall = (call: PreparedRoundToolCall) =>
        this.executeSingleToolCall({
          input: input.input,
          toolExecutor: input.toolExecutor,
          toolContext: input.toolContext,
          round: input.round,
          call,
          previousResults: roundResults,
        });
      const batchExecutions =
        input.parallelIndependent && batch.length > 1
          ? await Promise.all(batch.map((call) => runCall(call)))
          : await runSequentially(batch, runCall);
      for (const execution of batchExecutions) {
        roundResults.set(execution.index + 1, execution.result);
        executions.set(execution.index, execution);
      }
    }
    return [...executions.values()].sort((left, right) => left.index - right.index);
  }

  private async executeSingleToolCall(input: {
    input: AgentRuntimeRequest;
    toolExecutor: RuntimeToolExecutor;
    toolContext: RuntimeToolExecutionContext;
    round: number;
    call: PreparedRoundToolCall;
    previousResults: Map<number, ToolExecutionResult>;
  }): Promise<RuntimeToolRoundExecution> {
    const order = input.call.index + 1;
    const toolArguments = resolveToolArgumentReferences(input.call.arguments, input.previousResults);
    await input.input.onEvent?.({
      type: "runtime.tool_call",
      data: {
        agent_name: input.input.agent.agent_name,
        tool_call_id: input.call.callId,
        tool_name: input.call.toolName,
        arguments: toolArguments,
        round: input.round,
        order,
        round_index: order,
      },
    });

    const startedAt = Date.now();
    const unresolvedPlaceholders = collectResultPlaceholders(toolArguments);
    const toolResult = unresolvedPlaceholders.length
      ? buildToolReferenceErrorResult(input.call.toolName, unresolvedPlaceholders)
      : await executeToolSafely({
          toolExecutor: input.toolExecutor,
          toolContext: input.toolContext,
          callId: input.call.callId,
          toolName: input.call.toolName,
          toolArguments,
          round: input.round,
          index: input.call.index,
        });
    const observationResult = await resolveToolObservation({
      toolExecutor: input.toolExecutor,
      toolContext: buildToolCallExecutionContext(input.toolContext, {
        callId: input.call.callId,
        round: input.round,
        index: input.call.index,
      }),
      callId: input.call.callId,
      toolName: input.call.toolName,
      result: toolResult,
      agent: input.input.agent,
      provider: input.input.provider,
      dataRoot: this.dataRoot,
    });
    const elapsedTime = (Date.now() - startedAt) / 1000;
    await input.input.onEvent?.({
      type: "runtime.tool_result",
      data: {
        agent_name: input.input.agent.agent_name,
        tool_call_id: input.call.callId,
        tool_name: input.call.toolName,
        success: observationResult.success,
        summary: observationResult.summary,
        observation: observationResult.observation,
        metadata: toolResult.metadata,
        raw_result: observationResult.rawResult,
        raw_result_ref: buildRawResultRef(input.toolContext, input.call.callId, input.call.toolName),
        raw_result_available: true,
        elapsed_time: elapsedTime,
        round: input.round,
        order,
        round_index: order,
      },
    });

    return {
      index: input.call.index,
      callId: input.call.callId,
      toolName: input.call.toolName,
      arguments: toolArguments,
      result: toolResult,
      observation: observationResult.observation,
    };
  }
}

interface PreparedRoundToolCall {
  index: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

interface RuntimeToolRoundExecution {
  index: number;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: ToolExecutionResult;
  observation: string;
}

interface ToolObservationResult {
  success: boolean;
  summary: string;
  observation: string;
  rawResult: Record<string, unknown>;
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

function buildExecutionBatches(calls: PreparedRoundToolCall[]): PreparedRoundToolCall[][] {
  const batches: PreparedRoundToolCall[][] = [];
  const completed = new Set<number>();
  let remaining = [...calls];
  while (remaining.length > 0) {
    const batch: PreparedRoundToolCall[] = [];
    const nextRemaining: PreparedRoundToolCall[] = [];
    for (const call of remaining) {
      if (toolCallHasUnmetDependencies(call, completed)) {
        nextRemaining.push(call);
      } else {
        batch.push(call);
      }
    }
    if (batch.length === 0) {
      const [first, ...rest] = remaining;
      if (first) {
        batch.push(first);
      }
      remaining = rest;
    } else {
      remaining = nextRemaining;
    }
    for (const call of batch) {
      completed.add(call.index + 1);
    }
    batches.push(batch);
  }
  return batches;
}

function toolCallHasUnmetDependencies(call: PreparedRoundToolCall, completed: Set<number>): boolean {
  const dependencies = collectResultReferenceIndexes(call.arguments);
  return dependencies.some((index) => !completed.has(index));
}

async function runSequentially<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await run(item));
  }
  return results;
}

async function executeToolSafely(input: {
  toolExecutor: RuntimeToolExecutor;
  toolContext: RuntimeToolExecutionContext;
  callId: string;
  toolName: string;
  toolArguments: Record<string, unknown>;
  round: number;
  index: number;
}): Promise<ToolExecutionResult> {
  try {
    return await input.toolExecutor.executeTool(
      {
        toolName: input.toolName,
        arguments: input.toolArguments,
        callId: input.callId,
      },
      buildToolCallExecutionContext(input.toolContext, {
        callId: input.callId,
        round: input.round,
        index: input.index,
      }),
    );
  } catch (error) {
    return buildToolExecutionErrorResult(input.toolName, error);
  }
}

async function resolveToolObservation(input: {
  toolExecutor: RuntimeToolExecutor;
  toolContext: RuntimeToolExecutionContext;
  callId: string;
  toolName: string;
  result: ToolExecutionResult;
  agent: AgentConfig;
  provider: ModelProviderConfig;
  dataRoot: string;
}): Promise<ToolObservationResult> {
  const waitSignal = extractToolWaitSignal(input.result);
  if (!waitSignal || !input.toolExecutor.waitForToolResult) {
    const llmFacingResult = await buildLlmFacingToolResult(input);
    return {
      success: input.result.success,
      summary: input.result.summary,
      observation: renderToolResultContent({
        callId: input.callId,
        toolName: input.toolName,
        result: llmFacingResult,
      }),
      rawResult: materializeToolResult(input.result),
    };
  }

  const waitResult = await input.toolExecutor.waitForToolResult(
    {
      backgroundTaskId: waitSignal.backgroundTaskId,
      timeoutMs: waitSignal.timeoutMs,
    },
    input.toolContext,
  );
  const observation = renderBackgroundWaitObservation(waitResult);
  return {
    success: waitResult.success,
    summary: summarizeBackgroundWaitResult(waitResult),
    observation,
    rawResult: {
      background_notifications: waitResult.payloads,
    },
  };
}

function extractToolWaitSignal(result: ToolExecutionResult): {
  backgroundTaskId: string;
  timeoutMs?: number | null | undefined;
} | null {
  for (const payload of [result.content, result.metadata]) {
    if (!isRecord(payload) || payload.suggest_wait !== true) {
      continue;
    }
    const backgroundTaskId = asNonEmptyString(payload.background_task_id);
    if (!backgroundTaskId) {
      continue;
    }
    return {
      backgroundTaskId,
      timeoutMs: typeof payload.wait_timeout_ms === "number" && Number.isFinite(payload.wait_timeout_ms)
        ? payload.wait_timeout_ms
        : null,
    };
  }
  return null;
}

function renderBackgroundWaitObservation(waitResult: RuntimeToolWaitResult): string {
  return waitResult.payloads
    .map((payload) => renderBackgroundNotification(payload, waitResult.timeout))
    .filter((content) => content.trim())
    .join("\n\n");
}

function renderBackgroundNotification(payload: Record<string, unknown>, timeout: boolean): string {
  const taskId = asNonEmptyString(payload.background_task_id) ?? asNonEmptyString(payload.task_id) ?? "unknown";
  const status = asNonEmptyString(payload.status) ?? (timeout ? "running" : "completed");
  const outputPath = asNonEmptyString(payload.output_path) ?? asNonEmptyString(payload.background_output_path);
  const returnCode = payload.return_code;
  const resultType = asNonEmptyString(payload.result_type);
  const summary = asNonEmptyString(payload.summary) ?? asNonEmptyString(payload.description);
  const parts = ["<task-notification>", `<task-id>${escapeXmlText(taskId)}</task-id>`];
  if (outputPath) {
    parts.push(`<output-file>${escapeXmlText(outputPath)}</output-file>`);
  }
  parts.push(`<status>${escapeXmlText(status)}</status>`);
  if (returnCode !== null && returnCode !== undefined) {
    parts.push(`<return-code>${escapeXmlText(String(returnCode))}</return-code>`);
  }
  if (resultType) {
    parts.push(`<result-type>${escapeXmlText(resultType)}</result-type>`);
  }
  if (summary) {
    parts.push(`<summary>${escapeXmlText(summary)}</summary>`);
  }
  parts.push("</task-notification>");
  return parts.join("\n");
}

function summarizeBackgroundWaitResult(waitResult: RuntimeToolWaitResult): string {
  const summaries = waitResult.payloads
    .map((payload) => asNonEmptyString(payload.summary))
    .filter((summary): summary is string => Boolean(summary));
  if (summaries.length > 0) {
    return summaries.join("\n\n");
  }
  return waitResult.timeout ? "后台任务仍在运行" : "后台任务已完成";
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildRawResultRef(
  context: RuntimeToolExecutionContext,
  callId: string,
  toolName: string,
): Record<string, unknown> {
  return {
    session_id: context.sessionId ?? null,
    call_id: callId,
    tool_name: toolName,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
