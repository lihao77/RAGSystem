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
import type { PaginatedResult } from "../common.js";
import { PermissionModeSchema, type PermissionMode } from "../runtime/permissions.js";
import { OptionalSessionIdSchema } from "./session-id.js";
import type { TenantId } from "../../identity/types.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import { AgentConfigSchema, type AgentConfig } from "../agent/agent-config.js";
import { createHash } from "node:crypto";

export const SessionTeamSnapshotSchema = z.object({
  team_name: z.string().trim().min(1),
  team_revision: z.string().trim().min(1),
  entry_agent_name: z.string().trim().min(1),
  agents: z.record(z.string(), AgentConfigSchema),
}).strict().superRefine((snapshot, context) => {
  for (const [agentName, config] of Object.entries(snapshot.agents)) {
    if (config.agent_name !== agentName) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents", agentName, "agent_name"],
        message: `Agent key '${agentName}' does not match agent_name '${config.agent_name}'`,
      });
    }
  }
  if (!snapshot.agents[snapshot.entry_agent_name]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["entry_agent_name"],
      message: `Entry agent '${snapshot.entry_agent_name}' is not present in the Team snapshot`,
    });
  }
  const expectedRevision = computeSessionTeamRevision(snapshot.agents);
  if (snapshot.team_revision !== expectedRevision) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["team_revision"],
      message: "Team snapshot revision does not match its Agent configuration",
    });
  }
});

export interface SessionTeamSnapshot {
  team_name: string;
  team_revision: string;
  entry_agent_name: string;
  agents: Record<string, AgentConfig>;
}

export interface SessionTeamSnapshotResolver {
  createTeamSnapshot(input?: {
    teamName?: string | null | undefined;
    entryAgentName?: string | null | undefined;
  }): SessionTeamSnapshot;
}

/** Content-addressed identity for a normalized immutable Team Agent snapshot. */
export function computeSessionTeamRevision(agents: Record<string, unknown>): string {
  const normalized = Object.fromEntries(
    Object.entries(agents).map(([name, config]) => [name, AgentConfigSchema.parse(config)]),
  );
  return createHash("sha256").update(stableJson(normalized), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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
  attachments: z.array(AttachmentRefSchema).optional().default([]),
  ui_context: z.record(z.string(), z.unknown()).nullish(),
  // 请求级思考档位；缺省 = 跟随 provider 配置。
  thinking_level: z.enum(["off", "low", "medium", "high"]).nullish(),
}).strict();

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;
export type RollbackAndRetryRequest = z.infer<typeof RollbackAndRetryRequestSchema>;

export interface SessionInfo {
  session_id: string;
  team_snapshot: SessionTeamSnapshot;
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
  teamSnapshot: SessionTeamSnapshot;
  metadata?: Record<string, unknown>;
  permissionMode?: PermissionMode | null;
}

export type SessionIdentity = Omit<CreateSessionRecordInput, "tenantId">;

export type SessionCreateInput = Omit<SessionIdentity, "teamSnapshot"> & {
  teamName?: string | null;
  entryAgentName?: string | null;
};

export function toSessionIdentity(session: SessionInfo): SessionIdentity {
  return {
    sessionId: session.session_id,
    teamSnapshot: structuredClone(session.team_snapshot),
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
  "team",
  "entry_agent",
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
  content_parts: MessageContentPart[];
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

/**
 * 消息历史与 durable outbox 的一致快照。
 *
 * 客户端使用 outbox_watermark 作为首次 WebSocket after_seq，确保 HTTP 历史查询
 * 与 WebSocket 订阅之间提交的事件不会落入两者之间的空窗。
 */
export interface SessionMessageListSnapshot extends PaginatedResult<MessageInfo> {
  outbox_watermark: number;
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
  return metadata;
}

export function normalizeSessionTeamSnapshot(value: unknown): SessionTeamSnapshot {
  return SessionTeamSnapshotSchema.parse(value) as SessionTeamSnapshot;
}
