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
import type { RuntimeToolDefinition, RuntimeToolExecutionContext, RuntimeToolExecutor } from "./runtime-tool-types.js";

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
  signal?: AbortSignal;
  onEvent?: AgentRuntimeEventHandler;
  toolExecutor?: RuntimeToolExecutor | undefined;
  toolContext?: RuntimeToolExecutionContext | undefined;
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
      const result = shouldRunToolLoop(input, request)
        ? await this.runToolCallingText(input, request)
        : this.llmChatClient.stream
          ? await this.runStreamingText(input, request)
          : await this.llmChatClient.complete(request);
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

  buildMessages(agent: AgentConfig, conversation: ChatMessage[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const systemParts: string[] = [];
    const systemPrompt = getSystemPrompt(agent);
    if (systemPrompt) {
      systemParts.push(systemPrompt);
    }
    let conversationIndex = 0;
    while (conversation[conversationIndex]?.role === "system") {
      const content = conversation[conversationIndex]?.content.trim();
      if (content) {
        systemParts.push(content);
      }
      conversationIndex += 1;
    }
    if (systemParts.length > 0) {
      messages.push({ role: "system", content: systemParts.join("\n\n") });
    }
    messages.push(...conversation.slice(conversationIndex));
    return messages;
  }

  private buildChatRequest(input: AgentRuntimeRequest): ChatCompletionRequest {
    const request: ChatCompletionRequest = {
      messages: this.buildMessages(input.agent, input.conversation),
      model: input.modelName,
      provider: input.provider,
      agent: input.agent,
      temperature: input.agent.llm_tiers?.default?.temperature ?? null,
      maxCompletionTokens: input.agent.llm_tiers?.default?.max_completion_tokens ?? null,
    };
    if (input.toolExecutor && input.toolContext) {
      const visibleTools = input.toolExecutor.listVisibleTools(input.agent);
      if (visibleTools.length > 0) {
        request.tools = visibleTools.map(toChatToolDefinition);
        request.toolChoice = "auto";
      }
    }
    if (input.signal) {
      request.signal = input.signal;
    }
    return request;
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
      const result = await this.llmChatClient.complete({ ...request, messages });
      const toolCalls = result.toolCalls ?? [];
      if (toolCalls.length === 0) {
        return result;
      }
      if (round === maxToolRounds) {
        throw new Error(`Tool calling exceeded max rounds (${maxToolRounds})`);
      }

      messages = [...messages, buildAssistantToolCallMessage(result, toolCalls)];
      for (const toolCall of toolCalls) {
        const toolName = toolCall.function.name;
        await input.onEvent?.({
          type: "runtime.tool_call",
          data: {
            agent_name: input.agent.agent_name,
            tool_call_id: toolCall.id,
            tool_name: toolName,
            round,
          },
        });
        const toolResult = toolExecutor.executeTool(
          {
            toolName,
            arguments: parseToolArguments(toolCall),
            callId: toolCall.id,
          },
          toolContext,
        );
        await input.onEvent?.({
          type: "runtime.tool_result",
          data: {
            agent_name: input.agent.agent_name,
            tool_call_id: toolCall.id,
            tool_name: toolName,
            success: toolResult.success,
            summary: toolResult.summary,
          },
        });
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify(toolResult),
        });
      }
    }
    throw new Error(`Tool calling exceeded max rounds (${maxToolRounds})`);
  }

  private async runStreamingText(
    input: AgentRuntimeRequest,
    request: ChatCompletionRequest,
  ): Promise<{ content: string; raw?: unknown }> {
    let firstChunkSeen = false;
    const providerStartedAt = Date.now();
    return this.llmChatClient.stream!(request, async (chunk) => {
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
}

function shouldRunToolLoop(input: AgentRuntimeRequest, request: ChatCompletionRequest): boolean {
  return Boolean(input.toolExecutor && input.toolContext && request.tools?.length);
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

function getSystemPrompt(agent: AgentConfig): string | null {
  const behavior = agent.custom_params.behavior;
  if (!isRecord(behavior)) {
    return null;
  }
  return typeof behavior.system_prompt === "string" && behavior.system_prompt.trim()
    ? behavior.system_prompt.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
