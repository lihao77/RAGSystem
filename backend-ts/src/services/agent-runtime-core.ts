import type { AgentConfig } from "../contracts/agent-config.js";
import type { ModelProviderConfig } from "../contracts/model-adapter.js";
import type { ChatCompletionRequest, ChatMessage, LlmChatClient } from "./llm-chat-client.js";

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
      const result = this.llmChatClient.stream
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
    if (input.signal) {
      request.signal = input.signal;
    }
    return request;
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

function toRuntimeResult(input: AgentRuntimeRequest, result: { content: string; raw?: unknown }): AgentRuntimeResult {
  const runtimeResult: AgentRuntimeResult = {
    content: result.content,
    finish_reason: null,
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
