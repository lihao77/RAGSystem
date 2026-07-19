import type { ChatToolCall } from "@ragsystem/agent-llm";

/** Shared encoding of structured chat fields into message metadata. */
const CHAT_FIELDS_KEY = "chat_fields";

export interface ChatMessageFields {
  tool_calls?: ChatToolCall[] | undefined;
  tool_call_id?: string | undefined;
  name?: string | undefined;
}

export function encodeChatFields(metadata: Record<string, unknown>, fields: ChatMessageFields): Record<string, unknown> {
  const encoded: Record<string, unknown> = {};
  if (fields.tool_calls && fields.tool_calls.length > 0) encoded.tool_calls = fields.tool_calls;
  if (fields.tool_call_id) encoded.tool_call_id = fields.tool_call_id;
  if (fields.name) encoded.name = fields.name;
  return Object.keys(encoded).length === 0 ? metadata : { ...metadata, [CHAT_FIELDS_KEY]: encoded };
}

export function decodeChatFields(metadata: Record<string, unknown>): ChatMessageFields {
  const raw = metadata[CHAT_FIELDS_KEY];
  if (!raw || typeof raw !== "object") return {};
  const fields = raw as Record<string, unknown>;
  const result: ChatMessageFields = {};
  if (Array.isArray(fields.tool_calls) && fields.tool_calls.length > 0) result.tool_calls = fields.tool_calls as ChatToolCall[];
  if (typeof fields.tool_call_id === "string" && fields.tool_call_id) result.tool_call_id = fields.tool_call_id;
  if (typeof fields.name === "string" && fields.name) result.name = fields.name;
  return result;
}
