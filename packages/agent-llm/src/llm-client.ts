/**
 * Provider-agnostic LLM client facade.
 *
 * Protocol-specific behavior lives in providers/*. This facade only resolves the provider
 * capability and forwards the request to the matching adapter.
 */
import type { LlmClient, LlmRequest, LlmResult, LlmStreamHandler } from "./types.js";
import type { LlmProviderAdapter } from "./providers/adapter.js";
import { AnthropicAdapter } from "./providers/anthropic.js";
import { GeminiAdapter } from "./providers/gemini.js";
import { OpenAiChatAdapter } from "./providers/openai-chat.js";
import { OpenAiResponsesAdapter } from "./providers/openai-responses.js";
import { providerTypeSpec } from "./provider-registry.js";

const anthropic = new AnthropicAdapter();
const gemini = new GeminiAdapter();
const openAiChat = new OpenAiChatAdapter();
const openAiResponses = new OpenAiResponsesAdapter();

export class LlmProviderClient implements LlmClient {
  complete(request: LlmRequest): Promise<LlmResult> {
    return resolveAdapter(request).complete(request);
  }

  stream(request: LlmRequest, onChunk: LlmStreamHandler): Promise<LlmResult> {
    return resolveAdapter(request).stream(request, onChunk);
  }
}

function resolveAdapter(request: LlmRequest): LlmProviderAdapter {
  const providerType = request.provider.provider_type;
  const chatKind = providerTypeSpec(providerType)?.chatKind ?? null;
  if (chatKind === "openai_responses") return openAiResponses;
  if (chatKind === "anthropic") return anthropic;
  if (chatKind === "gemini") return gemini;
  if (chatKind === "openai_compatible") return openAiChat;
  throw new Error(`Provider type '${providerType}' does not support chat requests`);
}

/** Historical public name retained for source compatibility. */
export class OpenAiCompatibleClient extends LlmProviderClient {}
