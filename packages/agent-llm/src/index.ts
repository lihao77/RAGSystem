/**
 * @ragsystem/agent-llm 公共导出（LLM 通信基金层）。
 *
 * 零内部依赖、可独立使用。agent-sdk 依赖本包。
 */
export * from "./types.js";
export * from "./provider-registry.js";
export * from "./thinking.js";
export { compactRecord } from "./record-utils.js";
export * from "./content-parts.js";
export * from "./external-call-policy.js";
export * from "./provider-continuation.js";
export { LlmProviderClient, OpenAiCompatibleClient } from "./llm-client.js";
export { buildAnthropicBody } from "./providers/anthropic.js";
export { GeminiAdapter, buildGeminiBody, extractGeminiUsage, resolveGeminiEndpoint } from "./providers/gemini.js";
