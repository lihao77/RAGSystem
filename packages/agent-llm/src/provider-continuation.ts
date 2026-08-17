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
  if (value.protocol === "gemini_generate_content" && Array.isArray(value.parts)) {
    const parts = value.parts.filter(isRecord);
    if (parts.length === value.parts.length && parts.some((part) => isRecord(part.functionCall))) {
      return {
        protocol: "gemini_generate_content",
        toolCallIds: [...value.toolCallIds],
        parts,
      };
    }
  }
  if (value.protocol === "openai_chat" && isRecord(value.assistantFields)) {
    const assistantFields = parseOpenAiChatAssistantFields(value.assistantFields);
    if (Object.keys(assistantFields).length > 0) {
      return {
        protocol: "openai_chat",
        toolCallIds: [...value.toolCallIds],
        assistantFields,
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

function parseOpenAiChatAssistantFields(value: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (typeof value.reasoning_content === "string") fields.reasoning_content = value.reasoning_content;
  if (typeof value.reasoning === "string") fields.reasoning = value.reasoning;
  if (Array.isArray(value.reasoning_details)) fields.reasoning_details = value.reasoning_details.filter(isRecord).map((item) => ({ ...item }));
  return fields;
}
