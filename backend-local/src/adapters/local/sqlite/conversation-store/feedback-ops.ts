import type {
  MessageFeedback,
  MessageFeedbackValue,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";

interface FeedbackDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
}

interface FeedbackRow {
  message_id: string;
  session_id: string;
  tenant_id: string;
  value: MessageFeedbackValue;
  comment: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `message_id, session_id, tenant_id, value, comment, user_id, created_at, updated_at`;

function toFeedback(row: FeedbackRow): MessageFeedback {
  return {
    message_id: row.message_id,
    session_id: row.session_id,
    tenant_id: row.tenant_id,
    value: row.value,
    comment: row.comment,
    user_id: row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class MessageFeedbackOps {
  constructor(private readonly db: FeedbackDb) {}

  /** 幂等 upsert：每条消息至多一条反馈，后写覆盖（含评价人与评论），created_at 保留首次时间。 */
  set(input: {
    sessionId: string;
    messageId: string;
    tenantId: string;
    value: MessageFeedbackValue;
    comment?: string | null;
    userId?: string | null;
  }): MessageFeedback {
    const now = new Date().toISOString();
    const comment = input.comment?.trim() ? input.comment.trim() : null;
    this.db.prepare(
      `INSERT INTO message_feedback (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         value=excluded.value,
         comment=excluded.comment,
         user_id=excluded.user_id,
         updated_at=excluded.updated_at`,
    ).run(
      input.messageId,
      input.sessionId,
      input.tenantId,
      input.value,
      comment,
      input.userId ?? null,
      now,
      now,
    );
    return this.getRequired(input.sessionId, input.messageId);
  }

  clear(sessionId: string, messageId: string): boolean {
    const result = this.db.prepare(
      "DELETE FROM message_feedback WHERE message_id=? AND session_id=?",
    ).run(messageId, sessionId);
    return Number(result.changes) > 0;
  }

  list(sessionId: string): MessageFeedback[] {
    const rows = this.db.prepare(
      `SELECT ${COLUMNS} FROM message_feedback WHERE session_id=? ORDER BY updated_at DESC`,
    ).all(sessionId) as unknown as FeedbackRow[];
    return rows.map(toFeedback);
  }

  /** 租户级被踩清单（updated_at 倒序）：失败回流与团队健康度查询入口。 */
  listNegative(tenantId: string, options?: { since?: string; limit?: number }): MessageFeedback[] {
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const rows = options?.since
      ? this.db.prepare(
          `SELECT ${COLUMNS} FROM message_feedback
           WHERE tenant_id=? AND value='down' AND updated_at >= ?
           ORDER BY updated_at DESC LIMIT ?`,
        ).all(tenantId, options.since, limit) as unknown as FeedbackRow[]
      : this.db.prepare(
          `SELECT ${COLUMNS} FROM message_feedback
           WHERE tenant_id=? AND value='down'
           ORDER BY updated_at DESC LIMIT ?`,
        ).all(tenantId, limit) as unknown as FeedbackRow[];
    return rows.map(toFeedback);
  }

  private getRequired(sessionId: string, messageId: string): MessageFeedback {
    const row = this.db.prepare(
      `SELECT ${COLUMNS} FROM message_feedback WHERE message_id=? AND session_id=?`,
    ).get(messageId, sessionId) as unknown as FeedbackRow | undefined;
    if (!row) throw new Error(`message feedback upsert returned no row: ${messageId}`);
    return toFeedback(row);
  }
}
