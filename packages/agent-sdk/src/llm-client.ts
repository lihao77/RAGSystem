/**
 * SDK 内部默认 LLM 客户端——agent-llm OpenAiCompatibleClient 单例。
 *
 * createRuntime / compactSession 两个顶层入口共用：消费端不再注入 LlmClient，
 * SDK 据 profile.llmTiers 自带的 ProviderConfig 由 agent-llm 自行调用。
 * OpenAiCompatibleClient 无状态（无实例字段，每次请求自带 provider 做 fetch），单例跨 run 共享。
 */
import { OpenAiCompatibleClient, type LlmClient } from "@ragsystem/agent-llm";

let defaultClient: LlmClient | null = null;

/** 取 SDK 内部默认 LLM 客户端（惰性单例）。 */
export function getDefaultLlmClient(): LlmClient {
  return defaultClient ?? (defaultClient = new OpenAiCompatibleClient());
}
