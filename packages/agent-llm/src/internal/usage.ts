import type { TokenUsage } from "../types.js";
import { finiteNumber, isRecord } from "./records.js";

export function extractOpenAiUsage(body: unknown): TokenUsage | null {
  if (!isRecord(body) || !isRecord(body.usage)) return null;
  const deepSeekCacheHit = nonNegativeNumber(body.usage.prompt_cache_hit_tokens);
  const deepSeekCacheMiss = nonNegativeNumber(body.usage.prompt_cache_miss_tokens);
  // hit+miss 是输入总量的完整分解（DeepSeek 语义：两者之和 == prompt_tokens）。
  // 部分兼容网关的 input_tokens 不含缓存部分却单独上报 hit——此时以 hit+miss 为准，
  // 否则分母漏掉 cached 会让命中率虚高（甚至 >100%）。
  const deepSeekInputTotal = deepSeekCacheHit !== null && deepSeekCacheMiss !== null
    ? deepSeekCacheHit + deepSeekCacheMiss
    : null;
  const input = deepSeekInputTotal
    ?? finiteNumber(body.usage.prompt_tokens)
    ?? finiteNumber(body.usage.input_tokens)
    ?? (deepSeekCacheHit !== null || deepSeekCacheMiss !== null
      ? (deepSeekCacheHit ?? 0) + (deepSeekCacheMiss ?? 0)
      : null);
  const output = finiteNumber(body.usage.completion_tokens) ?? finiteNumber(body.usage.output_tokens);
  const promptDetails = isRecord(body.usage.prompt_tokens_details)
    ? body.usage.prompt_tokens_details
    : isRecord(body.usage.input_tokens_details)
      ? body.usage.input_tokens_details
      : null;
  const cachedInputTokens = (promptDetails ? nonNegativeNumber(promptDetails.cached_tokens) : null)
    ?? deepSeekCacheHit;
  const cacheCreationInputTokens = promptDetails
    ? nonNegativeNumber(promptDetails.cache_write_tokens) ?? nonNegativeNumber(promptDetails.cache_creation_input_tokens)
    : null;
  if (input === null && output === null && cachedInputTokens === null && cacheCreationInputTokens === null) return null;
  // 缓存 token 本身就是输入 token：网关轮次可能只报缓存明细而缺顶层总量（实测
  // input_tokens 缺失 + input_tokens_details.cached_tokens 在场的形状），输入下限
  // 收敛到 cached+creation，保证任何形状下命中率 ≤ 100%。
  const cacheFloor = (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  const inputTokens = Math.max(input ?? 0, cacheFloor);
  const outputTokens = output ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(finiteNumber(body.usage.total_tokens) ?? inputTokens + outputTokens, inputTokens),
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== null ? { cacheCreationInputTokens } : {}),
  };
}

export function extractAnthropicUsage(body: unknown): TokenUsage | null {
  if (!isRecord(body) || !isRecord(body.usage)) return null;
  const input = finiteNumber(body.usage.input_tokens);
  const output = finiteNumber(body.usage.output_tokens);
  const cacheCreationInputTokens = nonNegativeNumber(body.usage.cache_creation_input_tokens);
  const cachedInputTokens = nonNegativeNumber(body.usage.cache_read_input_tokens);
  if (input === null && output === null && cacheCreationInputTokens === null && cachedInputTokens === null) return null;
  // Anthropic reports uncached, cache-write, and cache-read input separately. All three
  // occupy the logical context window even though their billing rates differ.
  const inputTokens = Math.max(0, input ?? 0)
    + (cacheCreationInputTokens ?? 0)
    + (cachedInputTokens ?? 0);
  const outputTokens = output ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== null ? { cacheCreationInputTokens } : {}),
  };
}

export function extractGeminiUsage(body: unknown): TokenUsage | null {
  if (!isRecord(body) || !isRecord(body.usageMetadata)) return null;
  const input = nonNegativeNumber(body.usageMetadata.promptTokenCount);
  const total = nonNegativeNumber(body.usageMetadata.totalTokenCount);
  const candidates = nonNegativeNumber(body.usageMetadata.candidatesTokenCount);
  const thoughts = nonNegativeNumber(body.usageMetadata.thoughtsTokenCount);
  const cachedInputTokens = nonNegativeNumber(body.usageMetadata.cachedContentTokenCount);
  if (input === null && total === null && candidates === null && thoughts === null && cachedInputTokens === null) return null;
  // 同 OpenAI 提取器的输入下限：缓存 token 本身就是输入 token，总量缺失时至少计入缓存部分。
  const inputTokens = Math.max(input ?? 0, cachedInputTokens ?? 0);
  const outputTokens = total !== null
    ? Math.max(0, total - inputTokens)
    : (candidates ?? 0) + (thoughts ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: total ?? inputTokens + outputTokens,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
  };
}

function nonNegativeNumber(value: unknown): number | null {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}
