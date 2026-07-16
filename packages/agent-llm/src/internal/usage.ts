import type { TokenUsage } from "../types.js";
import { finiteNumber, isRecord } from "./records.js";

export function extractOpenAiUsage(body: unknown): TokenUsage | null {
  if (!isRecord(body) || !isRecord(body.usage)) return null;
  const input = finiteNumber(body.usage.prompt_tokens) ?? finiteNumber(body.usage.input_tokens);
  const output = finiteNumber(body.usage.completion_tokens) ?? finiteNumber(body.usage.output_tokens);
  if (input === null && output === null) return null;
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: finiteNumber(body.usage.total_tokens) ?? inputTokens + outputTokens,
  };
}

export function extractAnthropicUsage(body: unknown): TokenUsage | null {
  if (!isRecord(body) || !isRecord(body.usage)) return null;
  const input = finiteNumber(body.usage.input_tokens);
  const output = finiteNumber(body.usage.output_tokens);
  if (input === null && output === null) return null;
  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
