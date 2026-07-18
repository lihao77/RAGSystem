import { randomUUID } from "node:crypto";
import type { PaginatedResult } from "../../../contracts/common.js";
import type { TenantId } from "../../../identity/types.js";
import type { MessageInfo, SessionInfo, SessionListItem } from "../../../contracts/session.js";
import type { AddMessageInput } from "../../../contracts/conversation-store/index.js";
import { AddMessageInputSchema } from "../../../contracts/conversation-store/types.js";
import type { PermissionMode } from "../../../contracts/permissions.js";
import type { PostgresMemoryExecutor } from "./memory-repository.js";
import { decodeChatFields, encodeChatFields } from "../../../services/stores/conversation-store/chat-message-codec.js";

const iso = (value: unknown) => new Date(String(value)).toISOString();
const session = (row: Record<string, unknown>): SessionInfo => ({ session_id: String(row.session_id), tenant_id: row.tenant_id as TenantId, user_id: row.user_id == null ? null : String(row.user_id), permission_mode: row.permission_mode as PermissionMode | null, metadata: (row.metadata ?? {}) as Record<string, unknown>, created_at: iso(row.created_at), updated_at: iso(row.updated_at) });
const message = (row: Record<string, unknown>): MessageInfo => { const metadata = (row.metadata ?? {}) as Record<string, unknown>; return { seq: Number(row.seq), id: String(row.id), session_id: String(row.session_id), role: row.role as MessageInfo["role"], content: String(row.content), metadata, thread_key: String(row.thread_key ?? "root"), child_agent_id: row.child_agent_id == null ? null : String(row.child_agent_id), created_at: iso(row.created_at), ...(decodeChatFields(metadata) as any) }; };

/** Async SaaS port; the Local ConversationStore remains synchronous by design. */
export interface AsyncConversationRepository {
  createSession(...args: Parameters<PostgresConversationRepository["createSession"]>): Promise<void>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  listSessions(...args: Parameters<PostgresConversationRepository["listSessions"]>): Promise<PaginatedResult<SessionListItem>>;
  addMessage(input: AddMessageInput): Promise<MessageInfo>;
  listMessages(sessionId: string, limit?: number, offset?: number, threadKey?: string | null): Promise<PaginatedResult<MessageInfo>>;
  listVisibleRootMessages(sessionId: string, limit?: number, offset?: number): Promise<PaginatedResult<MessageInfo>>;
  getMessageBySeq(sessionId: string, seq: number): Promise<MessageInfo | null>;
  getMessageById(sessionId: string, id: string): Promise<MessageInfo | null>;
  getFirstMessageAfterSeq(sessionId: string, seq: number): Promise<MessageInfo | null>;
  listMessagesAfterSeq(sessionId: string, seq: number, limit?: number): Promise<MessageInfo[]>;
  listMessagesBeforeOrAtSeq(sessionId: string, seq: number, limit?: number): Promise<MessageInfo[]>;
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  deleteMessagesAfter(sessionId: string, input: { afterSeq?: number | null; afterMessageId?: string | null }): Promise<number>;
  updateMessage(input: { messageId: string; content?: string | null; metadata?: Record<string, unknown> | null; sessionId?: string | null; roleFilter?: MessageInfo["role"] | null }): Promise<boolean>;
  insertCompressionMessage(input: { sessionId: string; summaryContent: string; replacesUpToSeq?: number | null; threadKey?: string; childAgentId?: string | null; metadata?: Record<string, unknown> }): Promise<MessageInfo>;
}

export class PostgresConversationRepository implements AsyncConversationRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}
  async createSession(tenantId: TenantId, sessionId: string, userId: string | null, metadata: Record<string, unknown> = {}, permissionMode: PermissionMode | null = null): Promise<void> {
    const result = await this.executor.query(
      "INSERT INTO conversation_sessions(session_id,tenant_id,user_id,metadata,permission_mode) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(session_id) DO UPDATE SET user_id=COALESCE(EXCLUDED.user_id,conversation_sessions.user_id), metadata=conversation_sessions.metadata || EXCLUDED.metadata, permission_mode=COALESCE(EXCLUDED.permission_mode,conversation_sessions.permission_mode), updated_at=CURRENT_TIMESTAMP WHERE conversation_sessions.tenant_id=EXCLUDED.tenant_id RETURNING tenant_id",
      [sessionId, tenantId, userId, JSON.stringify(metadata), permissionMode],
    );
    if (!result.rows[0]) throw new Error(`session id is already owned by another tenant: ${sessionId}`);
  }
  async getSession(sessionId: string): Promise<SessionInfo | null> { const r = await this.executor.query("SELECT * FROM conversation_sessions WHERE session_id=$1", [sessionId]); return r.rows[0] ? session(r.rows[0]) : null; }
  async updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    return this.executor.transaction(async (executor) => {
      const current = await executor.query("SELECT metadata FROM conversation_sessions WHERE session_id=$1 FOR UPDATE", [sessionId]);
      if (!current.rows[0]) return null;
      const metadata = deepMergeRecords((current.rows[0].metadata ?? {}) as Record<string, unknown>, patch);
      const updated = await executor.query("UPDATE conversation_sessions SET metadata=$1::jsonb,updated_at=CURRENT_TIMESTAMP WHERE session_id=$2 RETURNING metadata", [JSON.stringify(metadata), sessionId]);
      return updated.rows[0] ? (updated.rows[0].metadata as Record<string, unknown>) : metadata;
    });
  }
  async updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> { const r = await this.executor.query("UPDATE conversation_sessions SET permission_mode=$1,updated_at=CURRENT_TIMESTAMP WHERE session_id=$2", [mode, sessionId]); return Number(r.rowCount ?? 0) > 0; }
  async deleteSession(sessionId: string): Promise<boolean> { const r = await this.executor.query("DELETE FROM conversation_sessions WHERE session_id=$1", [sessionId]); return Number(r.rowCount ?? 0) > 0; }
  async listSessions(tenantId: TenantId, limit = 20, offset = 0, userIds?: readonly string[] | null): Promise<PaginatedResult<SessionListItem>> { const params: unknown[] = [tenantId]; let where = "s.tenant_id=$1"; if (userIds) { if (!userIds.length) return { items: [], total: 0, limit, offset, has_more: false }; params.push(userIds); where += ` AND s.user_id=ANY($${params.length}::text[])`; } const total = await this.executor.query(`SELECT COUNT(*) AS total FROM conversation_sessions s WHERE ${where}`, params); params.push(limit, offset); const rows = await this.executor.query(`SELECT s.*, (SELECT content FROM conversation_messages m WHERE m.session_id=s.session_id AND ${visibleRootMessageSql("m")} ORDER BY seq DESC LIMIT 1) AS last_content, (SELECT created_at FROM conversation_messages m WHERE m.session_id=s.session_id AND ${visibleRootMessageSql("m")} ORDER BY seq DESC LIMIT 1) AS last_created_at, (SELECT content FROM conversation_messages m WHERE m.session_id=s.session_id AND ${visibleRootMessageSql("m")} ORDER BY seq ASC LIMIT 1) AS first_content FROM conversation_sessions s WHERE ${where} ORDER BY s.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params); return { items: rows.rows.map((r) => ({ ...session(r), title: String(r.first_content ?? ""), last_message: String(r.last_content ?? ""), last_message_at: r.last_created_at ? iso(r.last_created_at) : "", first_message: String(r.first_content ?? ""), unread_count: 0 })), total: Number(total.rows[0]?.total ?? 0), limit, offset, has_more: offset + limit < Number(total.rows[0]?.total ?? 0) }; }
  async addMessage(input: AddMessageInput): Promise<MessageInfo> { const normalized = AddMessageInputSchema.parse(input); const id = normalized.messageId ?? randomUUID(); const metadata = encodeChatFields({ ...(normalized.metadata ?? {}), thread_key: normalized.threadKey?.trim() || "root", ...(normalized.childAgentId ? { child_agent_id: normalized.childAgentId } : {}) }, { tool_calls: normalized.toolCalls as any, tool_call_id: normalized.toolCallId, name: normalized.name }); const r = await this.executor.query("INSERT INTO conversation_messages(id,session_id,role,content,metadata,thread_key,child_agent_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7) RETURNING *", [id, normalized.sessionId, normalized.role, normalized.content, JSON.stringify(metadata), metadata.thread_key, normalized.childAgentId ?? null]); await this.executor.query("UPDATE conversation_sessions SET updated_at=CURRENT_TIMESTAMP WHERE session_id=$1", [normalized.sessionId]); if (!r.rows[0]) throw new Error("message insert returned no row"); return message(r.rows[0]); }
  async listMessages(sessionId: string, limit = 10000, offset = 0, threadKey?: string | null): Promise<PaginatedResult<MessageInfo>> { const params: unknown[] = [sessionId, threadKey?.trim() || null]; const where = "session_id=$1 AND ($2::text IS NULL OR thread_key=$2)"; const total = await this.executor.query(`SELECT COUNT(*) AS total FROM conversation_messages WHERE ${where}`, params); params.push(limit, offset); const rows = await this.executor.query(`SELECT * FROM conversation_messages WHERE ${where} ORDER BY seq DESC LIMIT $3 OFFSET $4`, params); const items = rows.rows.map(message).reverse(); return { items, total: Number(total.rows[0]?.total ?? 0), limit, offset, has_more: offset + limit < Number(total.rows[0]?.total ?? 0) }; }
  async listVisibleRootMessages(sessionId: string, limit = 20, offset = 0): Promise<PaginatedResult<MessageInfo>> {
    const params: unknown[] = [sessionId];
    const where = `session_id=$1 AND ${visibleRootMessageSql()}`;
    const total = await this.executor.query(`SELECT COUNT(*) AS total FROM conversation_messages WHERE ${where}`, params);
    params.push(limit, offset);
    const rows = await this.executor.query(`SELECT * FROM conversation_messages WHERE ${where} ORDER BY seq DESC LIMIT $2 OFFSET $3`, params);
    const count = Number(total.rows[0]?.total ?? 0);
    return { items: rows.rows.map(message).reverse(), total: count, limit, offset, has_more: offset + limit < count };
  }
  async getMessageBySeq(sessionId: string, seq: number): Promise<MessageInfo | null> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND seq=$2", [sessionId, seq]); return r.rows[0] ? message(r.rows[0]) : null; }
  async getMessageById(sessionId: string, id: string): Promise<MessageInfo | null> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND id=$2", [sessionId, id]); return r.rows[0] ? message(r.rows[0]) : null; }
  async getFirstMessageAfterSeq(sessionId: string, seq: number): Promise<MessageInfo | null> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT 1", [sessionId, seq]); return r.rows[0] ? message(r.rows[0]) : null; }
  async listMessagesAfterSeq(sessionId: string, seq: number, limit = 20): Promise<MessageInfo[]> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [sessionId, seq, limit]); return r.rows.map(message); }
  async listMessagesBeforeOrAtSeq(sessionId: string, seq: number, limit = 20): Promise<MessageInfo[]> { const r = await this.executor.query("SELECT * FROM conversation_messages WHERE session_id=$1 AND seq<=$2 ORDER BY seq DESC LIMIT $3", [sessionId, seq, limit]); return r.rows.map(message); }
  async getRecentMessages(sessionId: string, limit = 10000, threadKey?: string | null): Promise<MessageInfo[]> { return (await this.listMessages(sessionId, limit, 0, threadKey)).items; }
  async deleteMessagesAfter(sessionId: string, input: { afterSeq?: number | null; afterMessageId?: string | null }): Promise<number> { let seq = input.afterSeq ?? null; if (seq == null && input.afterMessageId) { const r = await this.executor.query("SELECT seq FROM conversation_messages WHERE session_id=$1 AND id=$2", [sessionId, input.afterMessageId]); seq = r.rows[0] ? Number(r.rows[0].seq) : null; } if (seq == null) return 0; const r = await this.executor.query("DELETE FROM conversation_messages WHERE session_id=$1 AND seq>$2", [sessionId, seq]); return Number(r.rowCount ?? 0); }
  async updateMessage(input: { messageId: string; content?: string | null; metadata?: Record<string, unknown> | null; sessionId?: string | null; roleFilter?: MessageInfo["role"] | null }): Promise<boolean> { const sets: string[] = []; const p: unknown[] = []; if (input.content != null) { p.push(input.content); sets.push(`content=$${p.length}`); } if (input.metadata != null) { p.push(JSON.stringify(input.metadata)); sets.push(`metadata=$${p.length}::jsonb`); } if (!sets.length) return false; p.push(input.messageId); let where = `id=$${p.length}`; if (input.sessionId != null) { p.push(input.sessionId); where += ` AND session_id=$${p.length}`; } if (input.roleFilter != null) { p.push(input.roleFilter); where += ` AND role=$${p.length}`; } const r = await this.executor.query(`UPDATE conversation_messages SET ${sets.join(", ")} WHERE ${where}`, p); return Number(r.rowCount ?? 0) > 0; }
  async insertCompressionMessage(input: { sessionId: string; summaryContent: string; replacesUpToSeq?: number | null; threadKey?: string; childAgentId?: string | null; metadata?: Record<string, unknown> }): Promise<MessageInfo> { return this.addMessage({ sessionId: input.sessionId, role: "assistant", content: input.summaryContent, metadata: { ...(input.metadata ?? {}), ...(input.replacesUpToSeq == null ? {} : { replaces_up_to_seq: input.replacesUpToSeq }) }, threadKey: input.threadKey, childAgentId: input.childAgentId }); }
}

function visibleRootMessageSql(alias = ""): string {
  const column = (name: string) => alias ? `${alias}.${name}` : name;
  const metadata = column("metadata");
  return `${column("thread_key")}='root'
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
