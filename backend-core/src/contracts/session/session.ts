import { isRecord } from "../../utils/guards.js";

import { z } from "zod";
import {
  CreateSessionRequestSchema as SharedCreateSessionRequestSchema,
  SessionOriginChannelSchema,
  SessionOriginTypeSchema,
  SessionVisibilitySchema,
  UpdateSessionPermissionModeRequestSchema,
  type SessionOriginChannel,
  type SessionOriginType,
  type SessionVisibility,
} from "@ragsystem/api-contracts";

import { AttachmentRefSchema } from "../execution/execution.js";
import { PermissionModeSchema, type PermissionMode } from "../runtime/permissions.js";
import { OptionalSessionIdSchema } from "./session-id.js";
import type { TenantId } from "../../identity/types.js";

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

export const CreateSessionRequestSchema = SharedCreateSessionRequestSchema.extend({
  session_id: OptionalSessionIdSchema.nullable().optional(),
  permission_mode: PermissionModeSchema.nullable().optional(),
  metadata: SessionMetadataSchema,
});

export { UpdateSessionPermissionModeRequestSchema };

export const UpdateMessageRequestSchema = z.object({
  content: z.string(),
});

export const RollbackRequestSchema = z.object({
  after_seq: z.number().int().nullable().optional(),
  after_message_id: z.string().nullable().optional(),
});

export const RollbackAndRetryRequestSchema = RollbackRequestSchema.extend({
  modify_user_message: z.string().nullable().optional(),
  selected_llm: z.string().nullable().optional(),
  selectedLLM: z.string().nullable().optional(),
  attachments: z.array(AttachmentRefSchema).optional().default([]),
  ui_context: z.record(z.string(), z.unknown()).nullish(),
}).strict();

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;
export type RollbackAndRetryRequest = z.infer<typeof RollbackAndRetryRequestSchema>;

export interface SessionInfo {
  session_id: string;
  tenant_id: TenantId;
  owner_user_id: string | null;
  visibility: SessionVisibility;
  origin_type: SessionOriginType;
  origin_id: string | null;
  origin_channel: SessionOriginChannel;
  workspace_id: string | null;
  permission_mode: PermissionMode | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SessionListProjection {
  session_id: string;
  tenant_id: TenantId;
  owner_user_id: string | null;
  visibility: SessionVisibility;
  origin_type: SessionOriginType;
  origin_id: string | null;
  origin_channel: SessionOriginChannel;
  workspace_id: string | null;
  title: string;
  last_message: string;
  activity_at: string;
  first_message: string;
  unread_count: number;
}

export interface SessionListCursor {
  activityAt: string;
  sessionId: string;
}

export interface SessionListAccess {
  userId: string;
  includeTenant: boolean;
  includeAll?: boolean;
}

export interface SessionListQuery {
  tenantId: TenantId;
  access: SessionListAccess;
  limit: number;
  cursor?: SessionListCursor | null;
  originType?: SessionOriginType | null;
  originId?: string | null;
  workspaceId?: string | null;
}

export interface SessionListProjectionPage {
  items: SessionListProjection[];
  nextCursor: SessionListCursor | null;
}

export interface SessionFacetCounts {
  typeCounts: Record<SessionOriginType, number>;
  origins: Array<{ type: Exclude<SessionOriginType, "direct">; id: string; count: number }>;
  workspaces: Array<{ workspaceId: string; count: number }>;
}

export interface CreateSessionRecordInput {
  tenantId: TenantId;
  sessionId: string;
  ownerUserId: string | null;
  visibility: SessionVisibility;
  originType: SessionOriginType;
  originId: string | null;
  originChannel: SessionOriginChannel;
  workspaceId: string | null;
  metadata?: Record<string, unknown>;
  permissionMode?: PermissionMode | null;
}

export type SessionIdentity = Omit<CreateSessionRecordInput, "tenantId">;

export function toSessionIdentity(session: SessionInfo): SessionIdentity {
  return {
    sessionId: session.session_id,
    ownerUserId: session.owner_user_id,
    visibility: session.visibility,
    originType: session.origin_type,
    originId: session.origin_id,
    originChannel: session.origin_channel,
    workspaceId: session.workspace_id,
    metadata: session.metadata,
    permissionMode: session.permission_mode,
  };
}

export { SessionOriginChannelSchema, SessionOriginTypeSchema, SessionVisibilitySchema };
export type { SessionOriginChannel, SessionOriginType, SessionVisibility };

export const RESERVED_SESSION_METADATA_KEYS = [
  "workspace_root",
  "workspace_id",
  "widget",
  "origin",
  "origin_type",
  "origin_id",
  "origin_channel",
  "owner_user_id",
  "visibility",
] as const;

/**
 * 结构化工具调用（OpenAI tool call 标准形态）。与 @ragsystem/agent-llm 的 ChatToolCall
 * 结构一致（结构类型兼容），在 contracts 内独立定义以避免契约层反向依赖外部包。
 *
 * 跨协议统一：XML 与 FC 协议的 assistant 工具调用态消息都用此结构化字段承载调用参数，
 * 不再把调用信息塞进 content 文本。详见 contracts/conversation-store/chat-message-codec.ts。
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
  const reservedKey = RESERVED_SESSION_METADATA_KEYS.find((key) => key in metadata);
  if (reservedKey) {
    throw new Error(`metadata.${reservedKey} 是保留字段，请使用 Session 一等字段`);
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
