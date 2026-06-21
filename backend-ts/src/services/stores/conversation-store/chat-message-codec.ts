import type { ChatToolCall } from "../../integrations/llm-chat-client.js";

/**
 * ChatMessage 结构化字段（tool_calls / tool_call_id / name）↔ messages.metadata 的编解码。
 *
 * 跨协议统一形态：XML 与 FC 协议的 assistant 工具调用态、tool observation 消息，都用结构化
 * ChatMessage 字段承载（而非塞进 content 文本）。messages 表无独立列，这些字段编码进
 * metadata.chat_fields 子对象，使 store 层协议无关地无损存取。
 *
 * 序列化是 store 内部实现细节：addMessage 写入时 encode，rowToMessage 读出时 decode。
 * 调用方与消费方都只认 MessageInfo 的结构化字段（tool_calls/tool_call_id/name）。
 */

const CHAT_FIELDS_KEY = "chat_fields";

export interface ChatMessageFields {
  tool_calls?: ChatToolCall[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
}

/** 把结构化字段编码进 metadata（返回新对象，不改原 metadata）。无字段时原样返回。 */
export function encodeChatFields(
  metadata: Record<string, unknown>,
  fields: ChatMessageFields,
): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  if (fields.tool_calls && fields.tool_calls.length > 0) {
    encoded.tool_calls = fields.tool_calls;
  }
  if (fields.tool_call_id) {
    encoded.tool_call_id = fields.tool_call_id;
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
    result.tool_calls = fields.tool_calls as ChatToolCall[];
  }
  if (typeof fields.tool_call_id === "string" && fields.tool_call_id) {
    result.tool_call_id = fields.tool_call_id;
  }
  if (typeof fields.name === "string" && fields.name) {
    result.name = fields.name;
  }
  return result;
}
