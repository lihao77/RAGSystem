import { randomUUID } from "node:crypto";

import type { PaginatedResult } from "@ragsystem/backend-core/contracts/common.js";
import type { AddMessageInput } from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import { AddMessageInputSchema } from "@ragsystem/backend-core/contracts/conversation-store/types.js";
import { decodeChatFields, encodeChatFields } from "@ragsystem/backend-core/contracts/conversation-store/chat-message-codec.js";
import type { PermissionMode } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import type {
  CreateSessionRecordInput,
  MessageInfo,
  SessionFacetCounts,
  SessionInfo,
  SessionListProjection,
  SessionListProjectionPage,
  SessionListQuery,
  SessionMessageListSnapshot,
} from "@ragsystem/backend-core/contracts/session/session.js";
import { normalizeSessionMetadata } from "@ragsystem/backend-core/contracts/session/session.js";
import type { AsyncConversationRepository } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { PostgresExecutor } from "./postgres-executor.js";
import { MessageContentPartSchema, type MessageContentPart } from "@ragsystem/agent-protocol";

export type { AsyncConversationRepository } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";

const iso = (value: unknown) => new Date(String(value)).toISOString();

function session(row: Record<string, unknown>): SessionInfo {
  return {
    session_id: String(row.session_id),
    tenant_id: row.tenant_id as TenantId,
    owner_user_id: row.owner_user_id == null ? null : String(row.owner_user_id),
    visibility: row.visibility as SessionInfo["visibility"],
    origin_type: row.origin_type as SessionInfo["origin_type"],
    origin_id: row.origin_id == null ? null : String(row.origin_id),
    origin_channel: row.origin_channel as SessionInfo["origin_channel"],
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    permission_mode: row.permission_mode as PermissionMode | null,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

function projection(row: Record<string, unknown>): SessionListProjection {
  return {
    session_id: String(row.session_id),
    tenant_id: row.tenant_id as TenantId,
    owner_user_id: row.owner_user_id == null ? null : String(row.owner_user_id),
    visibility: row.visibility as SessionListProjection["visibility"],
    origin_type: row.origin_type as SessionListProjection["origin_type"],
    origin_id: row.origin_id == null ? null : String(row.origin_id),
    origin_channel: row.origin_channel as SessionListProjection["origin_channel"],
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    title: String(row.title ?? ""),
    first_message: String(row.first_message ?? ""),
    last_message: String(row.last_message ?? ""),
    activity_at: iso(row.activity_at),
    unread_count: Number(row.unread_count ?? 0),
  };
}

function message(row: Record<string, unknown>): MessageInfo {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const parsedContentParts = MessageContentPartSchema.array().safeParse(row.content_parts ?? []);
  if (!parsedContentParts.success) throw new Error(`Invalid content_parts for message ${String(row.id)}`);
  return {
    seq: Number(row.seq),
    id: String(row.id),
    session_id: String(row.session_id),
    role: row.role as MessageInfo["role"],
    content: String(row.content),
    content_parts: parsedContentParts.data,
    metadata,
    thread_key: String(row.thread_key ?? "root"),
    child_agent_id: row.child_agent_id == null ? null : String(row.child_agent_id),
    created_at: iso(row.created_at),
    ...(decodeChatFields(metadata) as Partial<MessageInfo>),
  };
}

export class PostgresConversationRepository implements AsyncConversationRepository {
  constructor(private readonly executor: PostgresExecutor) {}

  async createSession(input: CreateSessionRecordInput): Promise<void> {
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    await this.executor.transaction(async (executor) => {
      const inserted = await executor.query(
        `INSERT INTO conversation_sessions(
          session_id,tenant_id,owner_user_id,visibility,origin_type,origin_id,
          origin_channel,workspace_id,metadata,permission_mode
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
        ON CONFLICT(session_id) DO NOTHING
        RETURNING session_id`,
        [
          input.sessionId,
          input.tenantId,
          input.ownerUserId,
          input.visibility,
          input.originType,
          input.originId,
          input.originChannel,
          input.workspaceId,
          JSON.stringify(metadata),
          input.permissionMode ?? null,
        ],
      );
      if (inserted.rows[0]) return;
      const existing = await executor.query(
        `SELECT tenant_id,owner_user_id,visibility,origin_type,origin_id,origin_channel,workspace_id
         FROM conversation_sessions WHERE session_id=$1 FOR UPDATE`,
        [input.sessionId],
      );
      const row = existing.rows[0];
      if (!row || String(row.tenant_id) !== input.tenantId
        || nullableString(row.owner_user_id) !== input.ownerUserId
        || row.visibility !== input.visibility
        || row.origin_type !== input.originType
        || nullableString(row.origin_id) !== input.originId
        || row.origin_channel !== input.originChannel
        || nullableString(row.workspace_id) !== input.workspaceId) {
        throw new Error(`session id conflicts with a different immutable session identity: ${input.sessionId}`);
      }
    });
  }

  async getSession(sessionId: string): Promise<SessionInfo | null> {
    const result = await this.executor.query("SELECT * FROM conversation_sessions WHERE session_id=$1", [sessionId]);
    return result.rows[0] ? session(result.rows[0]) : null;
  }

  async updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.executor.transaction(async (executor) => {
      const current = await executor.query("SELECT metadata FROM conversation_sessions WHERE session_id=$1 FOR UPDATE", [sessionId]);
      if (!current.rows[0]) return null;
      const metadata = normalizeSessionMetadata(deepMergeRecords(
        (current.rows[0].metadata ?? {}) as Record<string, unknown>,
        patch,
      ));
      const updated = await executor.query(
        "UPDATE conversation_sessions SET metadata=$1::jsonb,updated_at=CURRENT_TIMESTAMP WHERE session_id=$2 RETURNING metadata",
        [JSON.stringify(metadata), sessionId],
      );
      return updated.rows[0] ? updated.rows[0].metadata as Record<string, unknown> : null;
    });
  }

  async updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> {
    const result = await this.executor.query(
      "UPDATE conversation_sessions SET permission_mode=$1,updated_at=CURRENT_TIMESTAMP WHERE session_id=$2",
      [mode, sessionId],
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await this.executor.query("DELETE FROM conversation_sessions WHERE session_id=$1", [sessionId]);
    return Number(result.rowCount ?? 0) > 0;
  }

  async listSessions(input: SessionListQuery): Promise<SessionListProjectionPage> {
    const params: unknown[] = [input.tenantId, input.access.userId, input.access.includeTenant, input.access.includeAll === true];
    const where = [
      "tenant_id=$1",
      "($4::boolean OR owner_user_id=$2 OR ($3::boolean AND visibility='tenant'))",
    ];
    if (input.originType) {
      params.push(input.originType);
      where.push(`origin_type=$${params.length}`);
    }
    if (input.originId) {
      params.push(input.originId);
      where.push(`origin_id=$${params.length}`);
    }
    if (input.workspaceId === "__unassigned__") {
      where.push("workspace_id IS NULL");
    } else if (input.workspaceId) {
      params.push(input.workspaceId);
      where.push(`workspace_id=$${params.length}`);
    }
    if (input.cursor) {
      params.push(input.cursor.activityAt, input.cursor.sessionId);
      where.push(`(activity_at,session_id) < ($${params.length - 1}::timestamptz,$${params.length})`);
    }
    params.push(input.limit + 1);
    const result = await this.executor.query(
      `SELECT * FROM conversation_session_list_projection
       WHERE ${where.join(" AND ")}
       ORDER BY activity_at DESC,session_id DESC
       LIMIT $${params.length}`,
      params,
    );
    const hasMore = result.rows.length > input.limit;
    const items = result.rows.slice(0, input.limit).map(projection);
    const boundary = hasMore ? items.at(-1) : null;
    return {
      items,
      nextCursor: boundary ? { activityAt: boundary.activity_at, sessionId: boundary.session_id } : null,
    };
  }

  async listSessionFacets(input: Pick<SessionListQuery, "tenantId" | "access">): Promise<SessionFacetCounts> {
    const params = [input.tenantId, input.access.userId, input.access.includeTenant, input.access.includeAll === true] as unknown[];
    const where = "tenant_id=$1 AND ($4::boolean OR owner_user_id=$2 OR ($3::boolean AND visibility='tenant'))";
    const [types, origins, workspaces] = await Promise.all([
      this.executor.query(`SELECT origin_type,COUNT(*)::integer AS count FROM conversation_session_list_projection WHERE ${where} GROUP BY origin_type`, params),
      this.executor.query(`SELECT origin_type,origin_id,COUNT(*)::integer AS count FROM conversation_session_list_projection WHERE ${where} AND origin_type IN ('bot','widget') GROUP BY origin_type,origin_id ORDER BY origin_type,origin_id`, params),
      this.executor.query(`SELECT workspace_id,COUNT(*)::integer AS count FROM conversation_session_list_projection WHERE ${where} AND workspace_id IS NOT NULL GROUP BY workspace_id ORDER BY workspace_id`, params),
    ]);
    const typeCounts: SessionFacetCounts["typeCounts"] = { direct: 0, bot: 0, widget: 0 };
    for (const row of types.rows) typeCounts[row.origin_type as keyof typeof typeCounts] = Number(row.count);
    return {
      typeCounts,
      origins: origins.rows.map((row) => ({
        type: row.origin_type as "bot" | "widget",
        id: String(row.origin_id),
        count: Number(row.count),
      })),
      workspaces: workspaces.rows.map((row) => ({ workspaceId: String(row.workspace_id), count: Number(row.count) })),
    };
  }

  async addMessage(input: AddMessageInput): Promise<MessageInfo> {
    const normalized = AddMessageInputSchema.parse(input);
    const id = normalized.messageId ?? randomUUID();
    const metadata = encodeChatFields({
      ...(normalized.metadata ?? {}),
      thread_key: normalized.threadKey?.trim() || "root",
      ...(normalized.childAgentId ? { child_agent_id: normalized.childAgentId } : {}),
    }, {
      tool_calls: normalized.toolCalls as never,
      tool_call_id: normalized.toolCallId,
      name: normalized.name,
    });
    const contentParts: MessageContentPart[] = (normalized.contentParts ?? []).length > 0
      ? normalized.contentParts!
      : normalized.content ? [{ type: "text", text: normalized.content }] : [];
    return this.executor.transaction(async (executor) => {
      const result = await executor.query(
        "INSERT INTO conversation_messages(id,session_id,role,content,content_parts,metadata,thread_key,child_agent_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) RETURNING *",
        [id, normalized.sessionId, normalized.role, normalized.content, JSON.stringify(contentParts), JSON.stringify(metadata), metadata.thread_key, normalized.childAgentId ?? null],
      );
      await executor.query("UPDATE conversation_sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=$1", [normalized.sessionId]);
      if (!result.rows[0]) throw new Error("message insert returned no row");
      return message(result.rows[0]);
    });
  }

  async listMessages(sessionId: string, limit = 10_000, offset = 0, threadKey?: string | null): Promise<PaginatedResult<MessageInfo>> {
    const params: unknown[] = [sessionId, threadKey?.trim() || null];
    const where = "session_id=$1 AND ($2::text IS NULL OR thread_key=$2)";
    const total = await this.executor.query(`SELECT COUNT(*) AS total FROM conversation_messages WHERE ${where}`, params);
    params.push(limit, offset);
    const rows = await this.executor.query(`SELECT * FROM conversation_messages WHERE ${where} ORDER BY seq DESC LIMIT $3 OFFSET $4`, params);
    const count = Number(total.rows[0]?.total ?? 0);
    return { items: rows.rows.map(message).reverse(), total: count, limit, offset, has_more: offset + limit < count };
  }

  async listVisibleRootMessagesSnapshot(
    tenantId: TenantId,
    sessionId: string,
    limit = 20,
    offset = 0,
  ): Promise<SessionMessageListSnapshot> {
    const result = await this.executor.query<{
      items: unknown;
      total: unknown;
      outbox_watermark: unknown;
    }>(
      `WITH visible_messages AS MATERIALIZED (
         SELECT * FROM conversation_messages
         WHERE session_id=$2 AND ${visibleRootMessageSql()}
       ), page AS MATERIALIZED (
         SELECT * FROM visible_messages ORDER BY seq DESC LIMIT $3 OFFSET $4
       )
       SELECT
         COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.seq ASC) FROM page), '[]'::jsonb) AS items,
         (SELECT COUNT(*) FROM visible_messages) AS total,
         COALESCE((
           SELECT MAX(session_seq) FROM event_outbox
           WHERE tenant_id=$1 AND session_id=$2 AND event_type LIKE 'client.%'
         ), 0) AS outbox_watermark`,
      [tenantId, sessionId, limit, offset],
    );
    const snapshot = result.rows[0];
    const rawItems = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const count = Number(snapshot?.total ?? 0);
    const watermark = Number(snapshot?.outbox_watermark ?? 0);
    return {
      items: rawItems.filter(isRecord).map(message),
      total: count,
      limit,
      offset,
      has_more: offset + limit < count,
      outbox_watermark: Number.isSafeInteger(watermark) && watermark >= 0 ? watermark : 0,
    };
  }

  async getMessageBySeq(sessionId: string, seq: number): Promise<MessageInfo | null> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND seq=$2", [sessionId, seq]); return r.rows[0] ? message(r.rows[0]) : null; }
  async getMessageById(sessionId: string, id: string): Promise<MessageInfo | null> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND id=$2", [sessionId, id]); return r.rows[0] ? message(r.rows[0]) : null; }
  async getFirstMessageAfterSeq(sessionId: string, seq: number): Promise<MessageInfo | null> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT 1", [sessionId, seq]); return r.rows[0] ? message(r.rows[0]) : null; }
  async listMessagesAfterSeq(sessionId: string, seq: number, limit = 20): Promise<MessageInfo[]> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [sessionId, seq, limit]); return r.rows.map(message); }
  async listMessagesBeforeOrAtSeq(sessionId: string, seq: number, limit = 20): Promise<MessageInfo[]> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND seq<=$2 ORDER BY seq DESC LIMIT $3", [sessionId, seq, limit]); return r.rows.map(message); }
  async getRecentMessages(sessionId: string, limit = 10_000, threadKey?: string | null): Promise<MessageInfo[]> { return (await this.listMessages(sessionId, limit, 0, threadKey)).items; }

  async deleteMessagesAfter(sessionId: string, input: { afterSeq?: number | null; afterMessageId?: string | null }): Promise<number> {
    return this.executor.transaction(async (executor) => {
      let seq = input.afterSeq ?? null;
      if (seq == null && input.afterMessageId) {
        const boundary = await executor.query("SELECT seq FROM conversation_messages WHERE session_id=$1 AND id=$2", [sessionId, input.afterMessageId]);
        seq = boundary.rows[0] ? Number(boundary.rows[0].seq) : null;
      }
      if (seq == null) return 0;
      const result = await executor.query("DELETE FROM conversation_messages WHERE session_id=$1 AND seq>$2", [sessionId, seq]);
      return Number(result.rowCount ?? 0);
    });
  }

  async updateMessage(input: { messageId: string; content?: string | null; metadata?: Record<string, unknown> | null; sessionId?: string | null; roleFilter?: MessageInfo["role"] | null }): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.content != null) { params.push(input.content); sets.push(`content=$${params.length}`); }
    if (input.metadata != null) { params.push(JSON.stringify(input.metadata)); sets.push(`metadata=$${params.length}::jsonb`); }
    if (!sets.length) return false;
    params.push(input.messageId);
    let where = `id=$${params.length}`;
    if (input.sessionId != null) { params.push(input.sessionId); where += ` AND session_id=$${params.length}`; }
    if (input.roleFilter != null) { params.push(input.roleFilter); where += ` AND role=$${params.length}`; }
    const result = await this.executor.query(`UPDATE conversation_messages SET ${sets.join(", ")} WHERE ${where}`, params);
    return Number(result.rowCount ?? 0) > 0;
  }

  insertCompressionMessage(input: { sessionId: string; summaryContent: string; replacesUpToSeq?: number | null; threadKey?: string; childAgentId?: string | null; metadata?: Record<string, unknown> }): Promise<MessageInfo> {
    return this.addMessage({
      sessionId: input.sessionId,
      role: "assistant",
      content: input.summaryContent,
      metadata: { ...(input.metadata ?? {}), ...(input.replacesUpToSeq == null ? {} : { replaces_up_to_seq: input.replacesUpToSeq }) },
      threadKey: input.threadKey,
      childAgentId: input.childAgentId,
    });
  }
}

function visibleRootMessageSql(alias = ""): string {
  const column = (name: string) => alias ? `${alias}.${name}` : name;
  const metadata = column("metadata");
  return `${column("thread_key")}='root'
    AND ${column("child_agent_id")} IS NULL
    AND ${column("role")} IN ('user','assistant','system')
    AND ${metadata}->>'react_intermediate' IS DISTINCT FROM 'true'
    AND ${metadata}->>'visible_to_user' IS DISTINCT FROM 'false'
    AND ${metadata}->>'conversation_scope' IS DISTINCT FROM 'child'
    AND COALESCE(${metadata}->>'msg_type','') NOT IN ('intent','observation')`;
}

function deepMergeRecords(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const output = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const existing = output[key];
    output[key] = isRecord(existing) && isRecord(value) ? deepMergeRecords(existing, value) : value;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}
