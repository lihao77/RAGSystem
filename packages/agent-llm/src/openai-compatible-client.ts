/**
 * @deprecated Import `LlmProviderClient` from `llm-client.ts` instead.
 *
 * This compatibility entrypoint remains because existing agent-sdk, backend, plugins, and
 * direct consumers import `OpenAiCompatibleClient` from the old module name.
 */
export { LlmProviderClient, OpenAiCompatibleClient } from "./llm-client.js";
export { buildAnthropicBody } from "./providers/anthropic.js";
