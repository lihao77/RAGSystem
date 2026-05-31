import type { AgentConfig } from "../contracts/agent-config.js";
import type { ModelProviderConfig } from "../contracts/model-adapter.js";
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  LlmChatClient,
} from "./llm-chat-client.js";

export type AgentRuntimeCoreEvent =
  | {
      type: "llm.first_token";
      data: {
        elapsed_ms: number;
        agent_name: string;
      };
    }
  | {
      type: "output.chunk";
      data: {
        content: string;
        agent_name: string;
      };
    };

export interface AgentRuntimeCoreRunInput {
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName: string;
  conversation: ChatMessage[];
  signal?: AbortSignal;
  onEvent?: (event: AgentRuntimeCoreEvent) => void | Promise<void>;
}

export class AgentRuntimeCore {
  constructor(private readonly llmChatClient: LlmChatClient) {}

  async runText(input: AgentRuntimeCoreRunInput): Promise<ChatCompletionResult> {
    const request = this.buildChatRequest(input);
    if (this.llmChatClient.stream) {
      return this.runStreamingText(input, request);
    }
    return this.llmChatClient.complete(request);
  }

  buildMessages(agent: AgentConfig, conversation: ChatMessage[]): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const systemPrompt = getSystemPrompt(agent);
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt });
    }
    messages.push(...conversation);
    return messages;
  }

  private buildChatRequest(input: AgentRuntimeCoreRunInput): ChatCompletionRequest {
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
    input: AgentRuntimeCoreRunInput,
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResult> {
    let firstChunkSeen = false;
    const providerStartedAt = Date.now();
    return this.llmChatClient.stream!(request, async (chunk) => {
      if (!chunk.content) {
        return;
      }
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        await input.onEvent?.({
          type: "llm.first_token",
          data: {
            elapsed_ms: Date.now() - providerStartedAt,
            agent_name: input.agent.agent_name,
          },
        });
      }
      await input.onEvent?.({
        type: "output.chunk",
        data: {
          content: chunk.content,
          agent_name: input.agent.agent_name,
        },
      });
    });
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
