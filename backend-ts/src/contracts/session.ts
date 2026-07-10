import path from "node:path";

import { z } from "zod";

import { AttachmentRefSchema } from "./execution.js";

export const SessionMetadataSchema = z.unknown().optional().transform((value, context) => {
  try {
    return normalizeSessionMetadata(value);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
    return z.NEVER;
  }
});

export const CreateSessionRequestSchema = z.object({
  session_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
  metadata: SessionMetadataSchema,
});

export const UpdateMessageRequestSchema = z.object({
  content: z.string(),
});

export const RollbackRequestSchema = z.object({
  after_seq: z.number().int().nullable().optional(),
  after_message_id: z.string().nullable().optional(),
});

export const RollbackAndRetryRequestSchema = RollbackRequestSchema.extend({
  modify_user_message: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
  selected_llm: z.string().nullable().optional(),
  selectedLLM: z.string().nullable().optional(),
  attachments: z.array(AttachmentRefSchema).optional().default([]),
  ui_context: z.record(z.string(), z.unknown()).nullish(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;
export type RollbackAndRetryRequest = z.infer<typeof RollbackAndRetryRequestSchema>;

export interface SessionInfo {
  session_id: string;
  user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SessionListItem extends SessionInfo {
  title: string;
  last_message: string;
  last_message_at: string;
  first_message: string;
  unread_count: number;
}

/**
 * 结构化工具调用（OpenAI tool call 标准形态）。与 @ragsystem/agent-llm 的 ChatToolCall
 * 结构一致（结构类型兼容），在 contracts 内独立定义以避免契约层反向依赖外部包。
 *
 * 跨协议统一：XML 与 FC 协议的 assistant 工具调用态消息都用此结构化字段承载调用参数，
 * 不再把调用信息塞进 content 文本。详见 services/stores/conversation-store/chat-message-codec.ts。
 */
export interface MessageToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface MessageInfo {
  id: string;
  seq: number;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  thread_key: string;
  child_agent_id: string | null;
  /** assistant 工具调用态的结构化调用参数（跨协议统一）。 */
  tool_calls?: MessageToolCall[] | undefined;
  /** tool 消息关联的调用 id（observation 回填）。 */
  tool_call_id?: string | undefined;
  /** tool 消息的工具名。 */
  name?: string | undefined;
  has_execution?: boolean;
}

export function normalizeSessionMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("metadata 必须是对象");
  }

  const metadata: Record<string, unknown> = { ...value };
  if ("workspace_root" in metadata) {
    metadata.workspace_root = normalizeWorkspaceRoot(metadata.workspace_root);
  }
  if ("entry_agent" in metadata) {
    metadata.entry_agent = normalizeEntryAgent(metadata.entry_agent);
  }
  if ("team" in metadata) {
    const team = normalizeTeam(metadata.team);
    if (team === null) {
      delete metadata.team;
    } else {
      metadata.team = team;
    }
  }
  return metadata;
}

function normalizeWorkspaceRoot(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("metadata.workspace_root 必须是字符串或 null");
  }
  const normalized = stripWrappedQuotes(value);
  if (!normalized) {
    throw new Error("metadata.workspace_root 不能为空字符串");
  }
  if (!path.isAbsolute(normalized)) {
    throw new Error("metadata.workspace_root 必须是绝对路径");
  }
  return normalized;
}

function normalizeEntryAgent(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("metadata.entry_agent 必须是字符串或 null");
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("metadata.entry_agent 不能为空字符串");
  }
  return normalized;
}

function normalizeTeam(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("metadata.team 必须是字符串或 null");
  }
  const normalized = value.trim();
  return normalized || null;
}

function stripWrappedQuotes(value: string): string {
  const normalized = value.trim();
  if (normalized.length >= 2 && normalized[0] === normalized.at(-1) && (normalized[0] === "\"" || normalized[0] === "'")) {
    return normalized.slice(1, -1).trim();
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
