/**
 * Backward-compatible client facade.
 *
 * Provider-specific protocol behavior lives in providers/*. This file intentionally keeps the
 * historical class and buildAnthropicBody export stable for agent-sdk and direct consumers.
 */
import type { LlmClient, LlmRequest, LlmResult, LlmStreamHandler } from "./types.js";
import type { LlmProviderAdapter } from "./providers/adapter.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { OpenAiChatAdapter } from "./providers/openai-chat.js";
import { OpenAiResponsesAdapter } from "./providers/openai-responses.js";
import { OPENAI_COMPATIBLE_TYPES } from "./provider-registry.js";

const anthropic = new AnthropicAdapter();
const openAiChat = new OpenAiChatAdapter();
const openAiResponses = new OpenAiResponsesAdapter();

export class OpenAiCompatibleClient implements LlmClient {
  complete(request: LlmRequest): Promise<LlmResult> {
    return resolveAdapter(request).complete(request);
  }

  stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return resolveAdapter(request).stream(request, onChunk);
  }
}

function resolveAdapter(request: LlmRequest): LlmProviderAdapter {
  const providerType = request.provider.provider_type;
  if (providerType === "openai_resp") return openAiResponses;
  if (providerType === "anthropic") return anthropic;
  if (OPENAI_COMPATIBLE_TYPES.has(providerType)) return openAiChat;
  throw new Error(`Provider type '${providerType}' is not supported by the OpenAI-compatible client`);
}

export { buildAnthropicBody } from "./providers/anthropic.js";
