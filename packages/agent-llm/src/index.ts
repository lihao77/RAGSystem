/**
 * @ragsystem/agent-llm 公共导出（LLM 通信基金层）。
 *
 * 线协议依托官方 SDK（openai / @anthropic-ai/sdk / @google/genai），重试调度、熔断、
 * 看门狗与厂商语义层（续传态回放、思考档位、缓存断点）自持；流式归一采用块累加器模型
 * （参考 pi-ai）。agent-sdk 依赖本包。
 */
export * from "./types.js";
export * from "./provider-registry.js";
export * from "./thinking.js";
export { compactRecord } from "./record-utils.js";
export * from "./content-parts.js";
export * from "./external-call-policy.js";
export * from "./provider-continuation.js";
export {
  SESSION_ID_PLACEHOLDER,
  isValidHeaderName,
  isValidHeaderValue,
  resolveProviderHeaders,
} from "./provider-headers.js";
export { LlmProviderClient, OpenAiCompatibleClient } from "./llm-client.js";
export {
  configureWireCapture,
  isWireCaptureEnabled,
  wireCaptureStatus,
  wrapFetchWithWireCapture,
  type WireCaptureOptions,
} from "./wire-capture.js";
export { buildAnthropicBody } from "./providers/anthropic.js";
export { GeminiAdapter, buildGeminiBody, extractGeminiUsage } from "./providers/gemini.js";
