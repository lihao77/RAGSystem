/**
 * ChatMessage 结构化字段（tool_calls / tool_call_id / name）↔ messages.metadata 编解码。
 *
 * 与 backend-ts conversation-store/chat-message-codec.ts 逐字对齐：messages 表无独立列，
 * 结构化字段编码进 metadata.chat_fields 子对象，使 store 层协议无关地无损存取。
 * 同一编码 → backend-ts 直读同库时 decodeChatFields 还原一致。
 */
import type { ToolCallRef } from "../types.js";

const CHAT_FIELDS_KEY = "chat_fields";

export interface ChatMessageFields {
  toolCalls?: ToolCallRef[];
  toolCallId?: string;
  name?: string;
}

/** 把结构化字段编码进 metadata（返回新对象，不改原 metadata）。无字段时原样返回。 */
export function encodeChatFields(
  metadata: Record<string, unknown>,
  fields: ChatMessageFields,
): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  if (fields.toolCalls && fields.toolCalls.length > 0) {
    encoded.tool_calls = fields.toolCalls;
  }
  if (fields.toolCallId) {
    encoded.tool_call_id = fields.toolCallId;
  }
  if (fields.name) {
    encoded.name = fields.name;
  }
  if (Object.keys(encoded).length === 0) {
    return metadata;
  }
  return { ...metadata, [CHAT_FIELDS_KEY]: encoded };
}

/** 从 metadata 还原结构化字段。无 chat_fields 时返回空对象。 */
export function decodeChatFields(metadata: Record<string, unknown>): ChatMessageFields {
  const raw = metadata[CHAT_FIELDS_KEY];
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const fields = raw as Record<string, unknown>;
  const result: ChatMessageFields = {};
  if (Array.isArray(fields.tool_calls) && fields.tool_calls.length > 0) {
    result.toolCalls = fields.tool_calls as ToolCallRef[];
  }
  if (typeof fields.tool_call_id === "string" && fields.tool_call_id) {
    result.toolCallId = fields.tool_call_id;
  }
  if (typeof fields.name === "string" && fields.name) {
    result.name = fields.name;
  }
  return result;
}
