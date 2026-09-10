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
import { retiredToolNameAliases } from "../agent/tool-name-aliases.js";
import type { MessageProviderState } from "../conversation-store/types.js";
import { createHash } from "node:crypto";

const SessionTeamSnapshotObjectSchema = z.object({
  team_name: z.string().trim().min(1),
  team_revision: z.string().trim().min(1),
  entry_agent_name: z.string().trim().min(1),
  agents: z.record(z.string(), AgentConfigSchema),
}).strict();

/**
 * 会话 team 快照 schema（带形态归一）。
 *
 * preprocess 在校验前做两件事（幂等，parse 结果恒为现名形态）：
 * 1. enabled_tools 里的退役工具名（如 execute_bash → execute_shell）**逐项**改名——只改名字
 *    本身，保留重复项、不动非字符串项（脏项仍交 schema 拒绝）。不做全局去重：存量快照的
 *    revision 是按落库原形状（可能含重复工具名）算的，去重会让锚点失配、快照永久不可读。
 * 2. 重锚定：若库内 team_revision 恰等于退役名形状的哈希（存量快照的落库锚点），改写为
 *    现名形状的哈希。revision 从此始终等于 parse 结果内容的内容哈希，superRefine 保持
 *    单哈希严格校验，下游（run-engine 身份比对、SaaS createSession 冲突检测）比较原文即可一致。
 *    revision 与退役名哈希不符的（真正被篡改的）原样透传，交 superRefine 拒绝。
 */
export const SessionTeamSnapshotSchema = z.preprocess(normalizeSnapshotAgentsShape, SessionTeamSnapshotObjectSchema.superRefine((snapshot, context) => {
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
  if (snapshot.team_revision !== computeSessionTeamRevision(snapshot.agents)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["team_revision"],
      message: "Team snapshot revision does not match its Agent configuration",
    });
  }
}));

/** 快照 raw 输入上的退役工具名归一 + revision 重锚定（parse 前应用；非快照形状原样透传）。 */
function normalizeSnapshotAgentsShape(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.agents)) return value;
  // 一次 parse 内统一别名快照：改名映射与重锚定校验必须用同一份注册表状态。
  const aliases = retiredToolNameAliases();
  if (!Object.keys(aliases).length) return value;
  let renamed = false;
  const agents: Record<string, unknown> = {};
  for (const [agentName, config] of Object.entries(value.agents)) {
    if (!isRecord(config) || !isRecord(config.tools) || !Array.isArray(config.tools.enabled_tools)) {
      agents[agentName] = config;
      continue;
    }
    let agentRenamed = false;
    const enabledTools = config.tools.enabled_tools.map((tool: unknown) => {
      if (typeof tool === "string" && tool in aliases) {
        agentRenamed = true;
        return aliases[tool];
      }
      return tool;
    });
    renamed = renamed || agentRenamed;
    agents[agentName] = agentRenamed
      ? { ...config, tools: { ...config.tools, enabled_tools: enabledTools } }
      : config;
  }
  if (!renamed) return value;
  const revision = typeof value.team_revision === "string" ? value.team_revision : null;
  const reanchored = revision === null ? null : reanchorRevision(revision, value.agents, agents);
  return reanchored === null
    ? { ...value, agents }
    : { ...value, agents, team_revision: reanchored };
}

/**
 * 库内 revision 与退役名形状的哈希一致时，返回现名形状的哈希（重锚定）；不匹配或形状
 * 无法解析时返回 null——保持原值透传，交 superRefine 按单哈希严格校验拒绝。
 */
function reanchorRevision(revision: string, rawAgents: unknown, renamedAgents: unknown): string | null {
  try {
    if (revision !== computeSessionTeamRevision(rawAgents as Record<string, unknown>)) return null;
    return computeSessionTeamRevision(renamedAgents as Record<string, unknown>);
  } catch {
    return null;
  }
}

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
  // 请求级思考档位；缺省 = 跟随 agent tier 默认档位。
  thinking_level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max", "on"]).nullish(),
}).strict();

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;
export type RollbackAndRetryRequest = z.infer<typeof RollbackAndRetryRequestSchema>;

export interface SessionInfo {
  session_id: string;
  /**
   * null = team 快照特性（2026-08）之前的存量未锚定行。读取汇点用
   * hydrateSessionTeamSnapshot 透传 null；首次 ensureSession 带快照触达时
   * 锚定回填，此后恢复非空。执行链消费须走 requireSessionTeamSnapshot。
   */
  team_snapshot: SessionTeamSnapshot | null;
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
    teamSnapshot: structuredClone(requireSessionTeamSnapshot(session)),
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
  /** 唯一持久化内容形态；裸文本用 partsToPlainText 派生。 */
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
  /**
   * assistant 工具调用消息内嵌的 provider 私有推理状态（含签发者印章）。
   * 服务端域字段：仅恢复 continuation 的回放判定使用，任何面向客户端的投影必须剥离。
   */
  provider_state?: MessageProviderState | null | undefined;
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

/**
 * 读取汇点水合（形态归一层）：剔除存量行里遗留的保留字键。保留字规则收紧前，
 * 自由 metadata 曾合法承载 team/entry_agent 等团队路由（今天的语义由 Session
 * 一等字段与 team_snapshot 承载）；不剔除会让这些行的任何 metadata 合并更新
 * 在 normalizeSessionMetadata 的保留字校验处崩溃。其余键原样透传；行在下次
 * metadata 回写时落盘干净形状（自愈，无需批量迁移）。
 */
export function hydrateSessionMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const hydrated: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((RESERVED_SESSION_METADATA_KEYS as readonly string[]).includes(key)) continue;
    hydrated[key] = entry;
  }
  return hydrated;
}

export function normalizeSessionTeamSnapshot(value: unknown): SessionTeamSnapshot {
  // 退役工具名归一在 SessionTeamSnapshotSchema 的 preprocess 里完成，parse 结果恒为现名形态。
  return SessionTeamSnapshotSchema.parse(value) as SessionTeamSnapshot;
}

/**
 * 读取汇点水合（形态归一层）：NULL 是 team 快照特性前的存量未锚定形状，
 * 原样透传 null，交由首次 ensureSession 锚定回填收敛；其余形状仍严格校验。
 */
export function hydrateSessionTeamSnapshot(value: unknown): SessionTeamSnapshot | null {
  return value == null ? null : normalizeSessionTeamSnapshot(value);
}

/**
 * 执行链断言：会话必须已锚定 team 快照。存量未锚定行在进入执行前会经
 * ensureSession 回填，走到这里仍为 null 说明绕过了会话入口闸门——按
 * 缺失显式报错，不做静默兜底。
 */
export function requireSessionTeamSnapshot(session: SessionInfo): SessionTeamSnapshot {
  if (!session.team_snapshot) {
    throw new Error(`session team snapshot not anchored: ${session.session_id}`);
  }
  return session.team_snapshot;
}
