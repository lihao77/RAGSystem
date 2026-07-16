import type { ProviderContinuationState, ReasoningBlock } from "./types.js";
import { isRecord } from "./internal/records.js";

export function parseProviderContinuationState(value: unknown): ProviderContinuationState | null {
  if (!isRecord(value) || !isStringArray(value.toolCallIds)) return null;
  if (value.protocol === "anthropic_messages" && Array.isArray(value.blocks)) {
    const blocks = value.blocks.map(parseReasoningBlock);
    if (blocks.every((block): block is ReasoningBlock => block !== null)) {
      return { protocol: "anthropic_messages", toolCallIds: [...value.toolCallIds], blocks };
    }
  }
  if (value.protocol === "openai_responses" && typeof value.anchorCallId === "string" && value.anchorCallId && Array.isArray(value.reasoningItems)) {
    const items = value.reasoningItems.filter(isRecord);
    if (items.length === value.reasoningItems.length && items.every((item) => item.type === "reasoning")) {
      return {
        protocol: "openai_responses",
        toolCallIds: [...value.toolCallIds],
        anchorCallId: value.anchorCallId,
        reasoningItems: items,
      };
    }
  }
  return null;
}

function parseReasoningBlock(value: unknown): ReasoningBlock | null {
  if (!isRecord(value)) return null;
  if (value.type === "thinking" && typeof value.thinking === "string" && typeof value.signature === "string") {
    return { type: "thinking", thinking: value.thinking, signature: value.signature };
  }
  if (value.type === "redacted_thinking" && typeof value.data === "string") {
    return { type: "redacted_thinking", data: value.data };
  }
  return null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}
