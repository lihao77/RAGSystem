import { partsToPlainText } from "@ragsystem/agent-protocol";
import { MSG_TYPE } from "@ragsystem/backend-core/contracts/message-kinds.js";
import { isSessionListVisibleMessage } from "@ragsystem/backend-core/contracts/session/session-list-projection.js";
import type { MessageInfo } from "@ragsystem/backend-core/contracts/session/session.js";
import type { ConversationDb } from "./shared/db.js";
import { isoTimestampToSqlite } from "./helpers.js";
import type { SessionRow } from "./types.js";

/** SQL equivalent of the shared domain predicate, covered by the same test vectors. */
export function sessionListVisibleMessageSql(alias: string): string {
  return `${alias}.thread_key = 'root'
    AND ${alias}.child_agent_id IS NULL
    AND ${alias}.role IN ('user', 'assistant', 'system')
    AND COALESCE(json_extract(${alias}.metadata, '$.react_intermediate'), 0) != 1
    AND COALESCE(json_extract(${alias}.metadata, '$.visible_to_user'), 1) != 0
    AND COALESCE(json_extract(${alias}.metadata, '$.conversation_scope'), '') != 'child'
    AND COALESCE(json_extract(${alias}.metadata, '$.msg_type'), '') NOT IN ('${MSG_TYPE.OBSERVATION}')`;
}

/** 派生兜底标题：首条可见消息纯文本截 30 字符。 */
function derivedTitle(text: string): string {
  return text.trim().slice(0, 30);
}

export class SessionListProjector {
  constructor(private readonly db: ConversationDb) {}

  projectInsertedMessage(message: MessageInfo): void {
    if (!isSessionListVisibleMessage(message)) return;
    const text = partsToPlainText(message.content_parts);
    const hasEarlierVisible = Boolean(this.db.prepare(`
      SELECT 1 FROM messages m
      WHERE m.session_id=? AND m.seq < ? AND ${sessionListVisibleMessageSql("m")}
      LIMIT 1
    `).get(message.session_id, message.seq));
    // activity_at 是 SQLite 内部比较列（排序/游标按字典序），MessageInfo.created_at 已是带 Z 的 ISO，写回须转内部格式。
    this.db.prepare(`
      UPDATE session_list_projection SET
        title=?,
        first_message=CASE WHEN ? = 0 THEN ? ELSE first_message END,
        last_message=?, activity_at=?, unread_count=?
      WHERE session_id=?
    `).run(
      hasEarlierVisible
        ? this.currentTitle(message.session_id)
        : this.currentTitleOverride(message.session_id) ?? derivedTitle(text),
      hasEarlierVisible ? 1 : 0,
      text,
      text,
      isoTimestampToSqlite(message.created_at),
      0,
      message.session_id,
    );
  }

  rebuildSessionListProjection(sessionId: string): void {
    const session = this.getSession(sessionId);
    const first = this.db.prepare(`
      SELECT content_parts, created_at FROM messages m
      WHERE m.session_id=? AND ${sessionListVisibleMessageSql("m")}
      ORDER BY m.seq ASC LIMIT 1
    `).get(sessionId) as { content_parts: string; created_at: string } | undefined;
    const last = this.db.prepare(`
      SELECT content_parts, created_at FROM messages m
      WHERE m.session_id=? AND ${sessionListVisibleMessageSql("m")}
      ORDER BY m.seq DESC LIMIT 1
    `).get(sessionId) as { content_parts: string; created_at: string } | undefined;
    const firstText = first ? partsToPlainText(JSON.parse(first.content_parts)) : "";
    const lastText = last ? partsToPlainText(JSON.parse(last.content_parts)) : "";
    const titleOverride = this.currentTitleOverride(sessionId);
    this.db.prepare(`
      INSERT INTO session_list_projection (
        session_id, tenant_id, owner_user_id, visibility, origin_type, origin_id,
        origin_channel, workspace_id, title, first_message, last_message, activity_at, unread_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        tenant_id=excluded.tenant_id, owner_user_id=excluded.owner_user_id,
        visibility=excluded.visibility, origin_type=excluded.origin_type,
        origin_id=excluded.origin_id, origin_channel=excluded.origin_channel,
        workspace_id=excluded.workspace_id, title=excluded.title,
        first_message=excluded.first_message, last_message=excluded.last_message,
        activity_at=excluded.activity_at, unread_count=excluded.unread_count
    `).run(
      session.session_id, session.tenant_id, session.owner_user_id, session.visibility,
      session.origin_type, session.origin_id, session.origin_channel, session.workspace_id,
      titleOverride ?? derivedTitle(firstText), firstText,
      lastText, isoTimestampToSqlite(last?.created_at ?? session.created_at),
      0,
    );
  }

  /**
   * LLM 生成标题回写：title_override 与展示 title 同步落，后续消息插入与 rebuild
   * 均以 override 优先。EXISTS 守卫确保只在首条可见用户消息真实存在时回写
   * （触发通知的插入事务若回滚，此处静默跳过，不产生无消息来源的标题）。
   */
  updateTitle(sessionId: string, title: string): boolean {
    const result = this.db.prepare(`
      UPDATE session_list_projection SET title_override=?, title=?
      WHERE session_id=? AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.session_id=? AND m.role='user' AND ${sessionListVisibleMessageSql("m")}
        LIMIT 1
      )
    `).run(title, title, sessionId, sessionId);
    return Number(result.changes) > 0;
  }

  private getSession(sessionId: string): SessionRow {
    const row = this.db.prepare(`
      SELECT session_id, tenant_id, owner_user_id, visibility, origin_type, origin_id,
             origin_channel, workspace_id, permission_mode, metadata, created_at, updated_at
      FROM sessions WHERE session_id=?
    `).get(sessionId) as SessionRow | undefined;
    if (!row) throw new Error(`Cannot project missing session: ${sessionId}`);
    return row;
  }

  private currentTitle(sessionId: string): string {
    const row = this.db.prepare("SELECT title FROM session_list_projection WHERE session_id=?").get(sessionId) as { title: string } | undefined;
    return row?.title ?? "";
  }

  private currentTitleOverride(sessionId: string): string | null {
    const row = this.db.prepare("SELECT title_override FROM session_list_projection WHERE session_id=?").get(sessionId) as { title_override: string | null } | undefined;
    return row?.title_override ?? null;
  }
}
