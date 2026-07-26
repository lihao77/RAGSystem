import { MSG_TYPE } from "../../../../contracts/message-kinds.js";
import { isSessionListVisibleMessage } from "../../../../contracts/session/session-list-projection.js";
import type { MessageInfo } from "../../../../contracts/session/session.js";
import type { ConversationDb } from "./shared/db.js";
import type { SessionRow } from "./types.js";

/** SQL equivalent of the shared domain predicate, covered by the same test vectors. */
export function sessionListVisibleMessageSql(alias: string): string {
  return `${alias}.thread_key = 'root'
    AND ${alias}.child_agent_id IS NULL
    AND ${alias}.role IN ('user', 'assistant', 'system')
    AND COALESCE(json_extract(${alias}.metadata, '$.react_intermediate'), 0) != 1
    AND COALESCE(json_extract(${alias}.metadata, '$.visible_to_user'), 1) != 0
    AND COALESCE(json_extract(${alias}.metadata, '$.conversation_scope'), '') != 'child'
    AND COALESCE(json_extract(${alias}.metadata, '$.msg_type'), '') NOT IN ('${MSG_TYPE.INTENT}', '${MSG_TYPE.OBSERVATION}')`;
}

export class SessionListProjector {
  constructor(private readonly db: ConversationDb) {}

  projectInsertedMessage(message: MessageInfo): void {
    if (!isSessionListVisibleMessage(message)) return;
    const hasEarlierVisible = Boolean(this.db.prepare(`
      SELECT 1 FROM messages m
      WHERE m.session_id=? AND m.seq < ? AND ${sessionListVisibleMessageSql("m")}
      LIMIT 1
    `).get(message.session_id, message.seq));
    this.db.prepare(`
      UPDATE session_list_projection SET
        title=?,
        first_message=CASE WHEN ? = 0 THEN ? ELSE first_message END,
        last_message=?, activity_at=?, unread_count=?
      WHERE session_id=?
    `).run(
      hasEarlierVisible ? this.currentTitle(message.session_id) : message.content.trim().slice(0, 30),
      hasEarlierVisible ? 1 : 0,
      message.content,
      message.content,
      message.created_at,
      0,
      message.session_id,
    );
  }

  rebuildSessionListProjection(sessionId: string): void {
    const session = this.getSession(sessionId);
    const first = this.db.prepare(`
      SELECT content, created_at FROM messages m
      WHERE m.session_id=? AND ${sessionListVisibleMessageSql("m")}
      ORDER BY m.seq ASC LIMIT 1
    `).get(sessionId) as { content: string; created_at: string } | undefined;
    const last = this.db.prepare(`
      SELECT content, created_at FROM messages m
      WHERE m.session_id=? AND ${sessionListVisibleMessageSql("m")}
      ORDER BY m.seq DESC LIMIT 1
    `).get(sessionId) as { content: string; created_at: string } | undefined;
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
      first?.content.trim().slice(0, 30) ?? "", first?.content ?? "",
      last?.content ?? "", last?.created_at ?? session.created_at,
      0,
    );
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
}
