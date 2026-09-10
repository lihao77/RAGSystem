import { randomUUID } from "node:crypto";
import { hydrateMessageRequestStatus } from '@ragsystem/backend-core/contracts/session/message-request-status.js';

import { partsToPlainText } from "@ragsystem/agent-protocol";
import type { PaginatedResult } from "@ragsystem/backend-core/contracts/common.js";
import type { AddMessageInput } from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import { AddMessageInputSchema } from "@ragsystem/backend-core/contracts/conversation-store/types.js";
import { decodeChatFields, encodeChatFields, parseMessageProviderState } from "@ragsystem/backend-core/contracts/conversation-store/chat-message-codec.js";
import { isSessionListVisibleMessage } from "@ragsystem/backend-core/contracts/session/session-list-projection.js";
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
  SessionTeamSnapshot,
} from "@ragsystem/backend-core/contracts/session/session.js";
import { hydrateSessionMetadata, hydrateSessionTeamSnapshot, normalizeSessionMetadata, normalizeSessionTeamSnapshot } from "@ragsystem/backend-core/contracts/session/session.js";
import type { AsyncConversationRepository } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { PostgresExecutor } from "./postgres-executor.js";
import { MessageContentPartSchema, type MessageContentPart } from "@ragsystem/agent-protocol";

export type { AsyncConversationRepository } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";

const iso = (value: unknown) => new Date(String(value)).toISOString();

function session(row: Record<string, unknown>): SessionInfo {
  return {
    session_id: String(row.session_id),
    team_snapshot: hydrateSessionTeamSnapshot(row.team_snapshot),
    tenant_id: row.tenant_id as TenantId,
    owner_user_id: row.owner_user_id == null ? null : String(row.owner_user_id),
    visibility: row.visibility as SessionInfo["visibility"],
    origin_type: row.origin_type as SessionInfo["origin_type"],
    origin_id: row.origin_id == null ? null : String(row.origin_id),
    origin_channel: row.origin_channel as SessionInfo["origin_channel"],
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    permission_mode: row.permission_mode as PermissionMode | null,
    metadata: hydrateSessionMetadata(row.metadata),
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
    content_parts: parsedContentParts.data,
    metadata,
    thread_key: String(row.thread_key ?? "root"),
    child_agent_id: row.child_agent_id == null ? null : String(row.child_agent_id),
    created_at: iso(row.created_at),
    // JSONB 原样读出；印章/state 结构由恢复侧 parseProviderContinuationState 兜底校验。
    provider_state: parseMessageProviderState(row.provider_state),
    ...(decodeChatFields(metadata) as Partial<MessageInfo>),
  };
}

export class PostgresConversationRepository implements AsyncConversationRepository {
  /**
   * 首条可见用户消息确立时按租户回调（会话标题异步生成的触发点）。
   * 仓储实例进程级共享、租户无关；注册方是各租户容器（其 systemConfig/providers
   * 才携带正确的租户 LLM 配置），故以 tenantId 为键而不是单播。
   */
  private readonly sessionTitleNotifiers = new Map<TenantId, (sessionId: string, messageText: string) => void>();

  constructor(private readonly executor: PostgresExecutor) {}

  async beginMessageRequest(sessionId: string, requestId: string, content: string): Promise<boolean> {
    const result = await this.executor.query(`INSERT INTO session_message_requests(session_id, request_id, content, status)
      VALUES($1, $2, $3, 'processing') ON CONFLICT(session_id, request_id) DO NOTHING RETURNING request_id`, [sessionId, requestId, content]);
    return result.rows.length > 0;
  }

  async settleMessageRequest(sessionId: string, requestId: string, status: 'queued' | 'consumed' | 'failed', error?: string | null): Promise<void> {
    await this.executor.query(`UPDATE session_message_requests SET status=$3, error=$4, updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$1 AND request_id=$2 AND status='processing'`, [sessionId, requestId, status, error ?? null]);
  }

  async renewMessageRequest(sessionId: string, requestId: string): Promise<void> {
    await this.executor.query("UPDATE session_message_requests SET updated_at=CURRENT_TIMESTAMP WHERE session_id=$1 AND request_id=$2 AND status='processing'", [sessionId, requestId]);
  }

  async listMessageRequestStatuses(sessionId: string, requestIds: readonly string[] = []) {
    await this.executor.query(`UPDATE session_message_requests r SET status='failed', error='发送处理已中断，请重新发送', updated_at=CURRENT_TIMESTAMP
      WHERE session_id=$1 AND status='processing' AND updated_at<CURRENT_TIMESTAMP-INTERVAL '2 minutes'
        AND NOT EXISTS (SELECT 1 FROM conversation_messages m WHERE m.session_id=r.session_id AND m.role='user' AND m.thread_key='root' AND m.metadata->>'request_id'=r.request_id)
        AND NOT EXISTS (SELECT 1 FROM agent_mailbox_messages b WHERE b.session_id=r.session_id AND b.target_thread_key='root'
          AND b.input_type='user_message' AND b.metadata->>'request_id'=r.request_id)`, [sessionId]);
    await this.executor.query(`INSERT INTO session_message_requests(session_id, request_id, content, status, updated_at)
      SELECT session_id, metadata->>'request_id',
        COALESCE((SELECT string_agg(part->>'text', E'\\n') FROM jsonb_array_elements(content_parts) part WHERE part->>'type'='text'), ''),
        CASE WHEN EXISTS (SELECT 1 FROM conversation_messages m WHERE m.session_id=agent_mailbox_messages.session_id AND m.role='user'
          AND m.thread_key='root' AND m.metadata->>'request_id'=agent_mailbox_messages.metadata->>'request_id')
          THEN 'consumed' ELSE 'queued' END, updated_at FROM agent_mailbox_messages
      WHERE session_id=$1 AND target_thread_key='root' AND input_type='user_message' AND visible_to_user=TRUE
        AND status IN ('queued', 'claimed') AND jsonb_typeof(metadata->'request_id')='string'
        AND metadata->>'request_id'!=''
      ON CONFLICT(session_id, request_id) DO UPDATE SET
        status=CASE WHEN session_message_requests.status IN ('processing', 'queued', 'consumed', 'failed')
          THEN session_message_requests.status ELSE excluded.status END,
        content=COALESCE(NULLIF(session_message_requests.content, ''), excluded.content),
        updated_at=COALESCE(session_message_requests.updated_at, excluded.updated_at)
      WHERE session_message_requests.status NOT IN ('processing', 'queued', 'consumed', 'failed') OR session_message_requests.status IS NULL
        OR session_message_requests.content IS NULL OR session_message_requests.content=''
        OR session_message_requests.updated_at IS NULL`, [sessionId]);
    const result = await this.executor.query(`SELECT r.request_id, r.content,
      CASE WHEN m.id IS NOT NULL OR r.status='consumed' THEN 'consumed' WHEN r.status='failed' OR b.status='expired' THEN 'failed'
        WHEN b.status IN ('queued', 'claimed') THEN 'queued' ELSE r.status END AS status,
      m.id AS message_id, CASE WHEN b.status='expired' THEN COALESCE(b.last_error, '排队消息已过期') ELSE r.error END AS error, r.updated_at
      FROM session_message_requests r
      LEFT JOIN LATERAL (SELECT id FROM conversation_messages WHERE session_id=r.session_id
        AND role='user' AND thread_key='root' AND metadata->>'request_id'=r.request_id ORDER BY seq LIMIT 1) m ON TRUE
      LEFT JOIN LATERAL (SELECT status, last_error FROM agent_mailbox_messages WHERE session_id=r.session_id
        AND target_thread_key='root' AND input_type='user_message' AND metadata->>'request_id'=r.request_id ORDER BY seq LIMIT 1) b ON TRUE
      WHERE r.session_id=$1 AND ((r.status IN ('processing', 'queued') AND m.id IS NULL AND (b.status IS NULL OR b.status!='expired')) OR r.request_id=ANY($2::text[]))
      ORDER BY r.updated_at, r.request_id`, [sessionId, [...requestIds]]);
    return result.rows.map(hydrateMessageRequestStatus);
  }

  registerSessionTitleNotifier(tenantId: TenantId, notifier: (sessionId: string, messageText: string) => void): void {
    this.sessionTitleNotifiers.set(tenantId, notifier);
  }

  unregisterSessionTitleNotifier(tenantId: TenantId): void {
    this.sessionTitleNotifiers.delete(tenantId);
  }

  private notifySessionTitle(tenantId: TenantId, sessionId: string, messageText: string): void {
    try {
      this.sessionTitleNotifiers.get(tenantId)?.(sessionId, messageText);
    } catch {
      // 通知方违约（同步抛出）也不允许破坏消息写入路径。
    }
  }

  async createSession(input: CreateSessionRecordInput): Promise<void> {
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    const teamSnapshot = normalizeSessionTeamSnapshot(input.teamSnapshot);
    await this.executor.transaction(async (executor) => {
      const inserted = await executor.query(
        `INSERT INTO conversation_sessions(
          session_id,tenant_id,owner_user_id,visibility,origin_type,origin_id,
          origin_channel,workspace_id,metadata,permission_mode,team_snapshot
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb)
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
          JSON.stringify(teamSnapshot),
        ],
      );
      if (inserted.rows[0]) return;
      const existing = await executor.query(
        `SELECT tenant_id,owner_user_id,visibility,origin_type,origin_id,origin_channel,workspace_id,team_snapshot
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
        || nullableString(row.workspace_id) !== input.workspaceId
        || !sameTeamSnapshot(row.team_snapshot, teamSnapshot)) {
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
        hydrateSessionMetadata(current.rows[0].metadata),
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

  /** 锚定回填：仅命中仍未锚定的存量行（team_snapshot IS NULL），幂等。 */
  async anchorSessionTeamSnapshot(sessionId: string, snapshot: SessionTeamSnapshot): Promise<boolean> {
    const teamSnapshot = normalizeSessionTeamSnapshot(snapshot);
    const result = await this.executor.query(
      "UPDATE conversation_sessions SET team_snapshot=$1::jsonb,updated_at=CURRENT_TIMESTAMP WHERE session_id=$2 AND team_snapshot IS NULL",
      [JSON.stringify(teamSnapshot), sessionId],
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
    const metadata = encodeChatFields({ ...(normalized.metadata ?? {}) }, {
      tool_calls: normalized.toolCalls as never,
      tool_call_id: normalized.toolCallId,
      name: normalized.name,
    });
    const threadKey = normalized.threadKey?.trim() || "root";
    const contentParts: MessageContentPart[] = normalized.contentParts;
    // holder 规避 CFA 看不见闭包内赋值导致的 never 收窄
    const titleTrigger: { tenantId: TenantId | null } = { tenantId: null };
    const inserted = await this.executor.transaction(async (executor) => {
      // 首条可见用户消息确立检测（与 SQLite 端语义一致）：本条是可见 user 消息且
      // 之前无任何可见 user 消息。插入前在事务内检查，通知在提交后发出。
      const candidate = normalized.role === "user" && isSessionListVisibleMessage({
        role: normalized.role,
        metadata,
        thread_key: threadKey,
        child_agent_id: normalized.childAgentId ?? null,
      });
      if (candidate) {
        const identity = await executor.query(`
          SELECT s.tenant_id AS tenant_id, EXISTS (
            SELECT 1 FROM conversation_messages m
            WHERE m.session_id=s.session_id
              AND m.role='user'
              AND m.thread_key='root'
              AND m.child_agent_id IS NULL
              AND m.metadata->>'react_intermediate' IS DISTINCT FROM 'true'
              AND m.metadata->>'visible_to_user' IS DISTINCT FROM 'false'
              AND m.metadata->>'conversation_scope' IS DISTINCT FROM 'child'
              AND COALESCE(m.metadata->>'msg_type','') NOT IN ('observation')
            LIMIT 1
          ) AS has_earlier_visible_user
          FROM conversation_sessions s
          WHERE s.session_id=$1
        `, [normalized.sessionId]);
        const identityRow = identity.rows[0] as { tenant_id: string; has_earlier_visible_user: boolean } | undefined;
        if (identityRow && !identityRow.has_earlier_visible_user) {
          titleTrigger.tenantId = identityRow.tenant_id as TenantId;
        }
      }
      const result = await executor.query(
        "INSERT INTO conversation_messages(id,session_id,role,content_parts,metadata,thread_key,child_agent_id,provider_state) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb) RETURNING *",
        [id, normalized.sessionId, normalized.role, JSON.stringify(contentParts), JSON.stringify(metadata), threadKey, normalized.childAgentId ?? null, normalized.providerState ? JSON.stringify(normalized.providerState) : null],
      );
      await executor.query("UPDATE conversation_sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=$1", [normalized.sessionId]);
      if (!result.rows[0]) throw new Error("message insert returned no row");
      return message(result.rows[0]);
    });
    if (titleTrigger.tenantId !== null) {
      this.notifySessionTitle(titleTrigger.tenantId, normalized.sessionId, partsToPlainText(contentParts));
    }
    return inserted;
  }

  /** 单会话列表投影（title 回显等轻量读取）。 */
  async getSessionListProjection(sessionId: string): Promise<SessionListProjection | null> {
    const result = await this.executor.query(
      "SELECT * FROM conversation_session_list_projection WHERE session_id=$1",
      [sessionId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? projection(row) : null;
  }

  /**
   * LLM 生成标题回写：title_override 与展示 title 同步落，投影重建触发器以
   * override 优先。EXISTS 守卫确保只在可见用户消息真实存在时回写。
   */
  async updateSessionListTitle(sessionId: string, title: string): Promise<void> {
    await this.executor.query(`
      UPDATE conversation_session_list_projection SET title_override=$2, title=$2
      WHERE session_id=$1 AND EXISTS (
        SELECT 1 FROM conversation_messages m
        WHERE m.session_id=$1
          AND m.role='user'
          AND m.thread_key='root'
          AND m.child_agent_id IS NULL
          AND m.metadata->>'react_intermediate' IS DISTINCT FROM 'true'
          AND m.metadata->>'visible_to_user' IS DISTINCT FROM 'false'
          AND m.metadata->>'conversation_scope' IS DISTINCT FROM 'child'
          AND COALESCE(m.metadata->>'msg_type','') NOT IN ('observation')
        LIMIT 1
      )
    `, [sessionId, title]);
  }

  async listMessages(sessionId: string, limit = 10_000, offset = 0, threadKey?: string | null, runIds?: readonly string[]): Promise<PaginatedResult<MessageInfo>> {
    if (runIds?.length === 0) return { items: [], total: 0, limit, offset, has_more: false };
    const params: unknown[] = [sessionId, threadKey?.trim() || null];
    let where = "session_id=$1 AND ($2::text IS NULL OR thread_key=$2)";
    if (runIds) {
      // JSONB 比较保留字符串类型；JSON null 与字段缺失都回退到 run_id。
      where += " AND COALESCE(NULLIF(metadata->'consumed_by_run_id', 'null'::jsonb), metadata->'run_id') = ANY($3::jsonb[])";
      params.push(runIds.map((runId) => JSON.stringify(runId)));
    }
    const total = await this.executor.query(`SELECT COUNT(*) AS total FROM conversation_messages WHERE ${where}`, params);
    const limitParam = params.length + 1;
    params.push(limit, offset);
    const rows = await this.executor.query(`SELECT * FROM conversation_messages WHERE ${where} ORDER BY seq DESC LIMIT $${limitParam} OFFSET $${limitParam + 1}`, params);
    const count = Number(total.rows[0]?.total ?? 0);
    return { items: rows.rows.map(message).reverse(), total: count, limit, offset, has_more: offset + limit < count };
  }

  async listVisibleMessagesSnapshot(
    tenantId: TenantId,
    sessionId: string,
    threadKey: string,
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
         WHERE session_id=$2 AND ${visibleConversationMessageSql("", "$3")}
       ), page AS MATERIALIZED (
         SELECT * FROM visible_messages ORDER BY seq DESC LIMIT $4 OFFSET $5
       )
       SELECT
         COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.seq ASC) FROM page), '[]'::jsonb) AS items,
         (SELECT COUNT(*) FROM visible_messages) AS total,
         COALESCE((
           SELECT MAX(session_seq) FROM event_outbox
           WHERE tenant_id=$1 AND session_id=$2 AND event_type LIKE 'client.%'
         ), 0) AS outbox_watermark`,
      [tenantId, sessionId, threadKey, limit, offset],
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

  async deleteMessagesAfter(sessionId: string, input: {
    afterSeq?: number | null;
    afterMessageId?: string | null;
    tenantId?: string | null;
  }): Promise<number> {
    return this.executor.transaction(async (executor) => {
      let seq = input.afterSeq ?? null;
      if (seq == null && input.afterMessageId) {
        const boundary = await executor.query("SELECT seq FROM conversation_messages WHERE session_id=$1 AND id=$2", [sessionId, input.afterMessageId]);
        seq = boundary.rows[0] ? Number(boundary.rows[0].seq) : null;
      }
      if (seq == null) return 0;
      const tenantId = input.tenantId?.trim() || null;
      const truncations = await executor.query<{ run_id: string; from_step_order: number | string }>(`
        SELECT boundary.run_id, MIN(boundary.boundary_step_order) AS from_step_order
        FROM saas_run_message_boundaries AS boundary
        JOIN conversation_messages AS message
          ON message.session_id=boundary.session_id AND message.id=boundary.message_id
        WHERE boundary.tenant_id=$1 AND message.session_id=$2 AND message.seq>$3
          AND boundary.boundary_step_order IS NOT NULL
        GROUP BY boundary.run_id
      `, [tenantId, sessionId, seq]);
      const deletedRuns = await executor.query<{ run_id: string }>(`
        WITH deleted_runs AS (
          SELECT DISTINCT COALESCE(
            NULLIF(metadata->>'consumed_by_run_id', ''),
            NULLIF(metadata->>'run_id', '')
          ) AS run_id
          FROM conversation_messages
          WHERE session_id=$1 AND seq>$2
            AND COALESCE(
              NULLIF(metadata->>'consumed_by_run_id', ''),
              NULLIF(metadata->>'run_id', '')
            ) IS NOT NULL
          UNION
          SELECT DISTINCT boundary.run_id
          FROM saas_run_message_boundaries AS boundary
          JOIN conversation_messages AS message
            ON message.session_id=boundary.session_id AND message.id=boundary.message_id
          WHERE boundary.tenant_id=$3 AND message.session_id=$1 AND message.seq>$2
        )
        SELECT deleted.run_id
        FROM deleted_runs AS deleted
        WHERE NOT EXISTS (
          SELECT 1 FROM conversation_messages AS surviving
          WHERE surviving.session_id=$1 AND surviving.seq<=$2
            AND COALESCE(
              NULLIF(surviving.metadata->>'consumed_by_run_id', ''),
              NULLIF(surviving.metadata->>'run_id', '')
            )=deleted.run_id
        )
          AND NOT EXISTS (
            SELECT 1
            FROM saas_run_message_boundaries AS boundary
            JOIN conversation_messages AS surviving
              ON surviving.session_id=boundary.session_id AND surviving.id=boundary.message_id
            WHERE boundary.tenant_id=$3 AND surviving.session_id=$1
              AND surviving.seq<=$2 AND boundary.run_id=deleted.run_id
          )
      `, [sessionId, seq, tenantId]);
      if ((deletedRuns.rows.length > 0 || truncations.rows.length > 0) && !tenantId) {
        throw new Error("tenantId is required to delete SaaS run steps");
      }
      const fullyDeletedRunIds = deletedRuns.rows.map((row) => String(row.run_id));
      const fullyDeletedRunIdSet = new Set(fullyDeletedRunIds);
      for (const truncation of truncations.rows) {
        if (fullyDeletedRunIdSet.has(truncation.run_id)) continue;
        const fromStepOrder = Number(truncation.from_step_order);
        await executor.query(
          `DELETE FROM saas_run_message_boundaries
           WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3
             AND (start_after_step_order>=$4 OR boundary_step_order>=$4)`,
          [tenantId, sessionId, truncation.run_id, fromStepOrder],
        );
        await executor.query(
          "DELETE FROM saas_run_steps WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND step_order>=$4",
          [tenantId, sessionId, truncation.run_id, fromStepOrder],
        );
      }
      if (fullyDeletedRunIds.length > 0) {
        await executor.query(
          "DELETE FROM saas_run_message_boundaries WHERE tenant_id=$1 AND session_id=$2 AND run_id=ANY($3::text[])",
          [tenantId, sessionId, fullyDeletedRunIds],
        );
        await executor.query(
          "DELETE FROM saas_run_steps WHERE tenant_id=$1 AND session_id=$2 AND run_id=ANY($3::text[])",
          [tenantId, sessionId, fullyDeletedRunIds],
        );
      }
      // 被删消息的赞/踩反馈同步清理：反馈表无消息级外键，残留会污染被踩回流清单
      await executor.query(
        `DELETE FROM conversation_message_feedback
          WHERE session_id=$1 AND message_id IN (
            SELECT id FROM conversation_messages WHERE session_id=$1 AND seq>$2
          )`,
        [sessionId, seq],
      );
      const result = await executor.query("DELETE FROM conversation_messages WHERE session_id=$1 AND seq>$2", [sessionId, seq]);
      return Number(result.rowCount ?? 0);
    });
  }

  async updateMessage(input: { messageId: string; contentParts?: MessageContentPart[] | null; metadata?: Record<string, unknown> | null; sessionId?: string | null; roleFilter?: MessageInfo["role"] | null }): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (input.contentParts != null) { params.push(JSON.stringify(input.contentParts)); sets.push(`content_parts=$${params.length}::jsonb`); }
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
      contentParts: [{ type: "text", text: input.summaryContent }],
      metadata: { ...(input.metadata ?? {}), ...(input.replacesUpToSeq == null ? {} : { replaces_up_to_seq: input.replacesUpToSeq }) },
      threadKey: input.threadKey,
      childAgentId: input.childAgentId,
    });
  }
}

function sameTeamSnapshot(left: unknown, right: CreateSessionRecordInput["teamSnapshot"]): boolean {
  // 存量未锚定行（NULL）在此处即身份冲突，与 local createSession 的可选链口径一致。
  const parsed = hydrateSessionTeamSnapshot(left);
  if (!parsed) return false;
  const expected = normalizeSessionTeamSnapshot(right);
  return parsed.team_name === expected.team_name
    && parsed.team_revision === expected.team_revision
    && parsed.entry_agent_name === expected.entry_agent_name;
}

function visibleConversationMessageSql(alias = "", threadKeyParam = "$3"): string {
  const column = (name: string) => alias ? `${alias}.${name}` : name;
  const metadata = column("metadata");
  return `${column("thread_key")}=${threadKeyParam}
    AND ${column("role")} IN ('user','assistant','system')
    AND ${metadata}->'react_intermediate' IS DISTINCT FROM 'true'::jsonb
    AND ${metadata}->'hidden' IS DISTINCT FROM 'true'::jsonb
    AND (${metadata}->'visible_to_user' IS DISTINCT FROM 'false'::jsonb OR ${metadata}->'agent_message' = 'true'::jsonb)
    AND (${threadKeyParam} <> 'root' OR (
      ${column("child_agent_id")} IS NULL
      AND ${metadata}->>'conversation_scope' IS DISTINCT FROM 'child'
      AND COALESCE(${metadata}->>'msg_type','') NOT IN ('observation')
    ))`;
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
