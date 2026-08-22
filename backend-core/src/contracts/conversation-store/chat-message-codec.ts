import { parseProviderContinuationState, type ChatToolCall } from "@ragsystem/agent-llm";
import type { MessageProviderState } from "./types.js";

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

/**
 * 消息行 provider_state 解析：接受 JSON 字符串或对象（SQLite TEXT / Postgres JSONB 两种行形态）。
 * 破损、缺印章或 state 不合法时静默置空——该状态本就是尽力回放的隐藏态，坏行不拖垮历史重建。
 */
export function parseMessageProviderState(raw: unknown): MessageProviderState | null {
  try {
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
    if (typeof parsed !== "object" || parsed === null) return null;
    const envelope = parsed as { provider_key?: unknown; model?: unknown; state?: unknown };
    if (typeof envelope.provider_key !== "string" || !envelope.provider_key) return null;
    if (typeof envelope.model !== "string" || !envelope.model) return null;
    const state = parseProviderContinuationState(envelope.state);
    if (!state) return null;
    return { provider_key: envelope.provider_key, model: envelope.model, state };
  } catch {
    return null;
  }
}
