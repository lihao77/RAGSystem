import type {
  MessageFeedback,
  MessageFeedbackValue,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { AsyncMessageFeedbackStore } from "@ragsystem/backend-core/contracts/storage/async-persistence-ports.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { PostgresExecutor } from "./postgres-executor.js";

type FeedbackRow = {
  message_id: string;
  session_id: string;
  tenant_id: string | number;
  value: MessageFeedbackValue;
  comment: string | null;
  user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toFeedback(row: FeedbackRow): MessageFeedback {
  return {
    message_id: row.message_id,
    session_id: row.session_id,
    tenant_id: String(row.tenant_id),
    value: row.value,
    comment: row.comment,
    user_id: row.user_id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

const COLUMNS = `message_id, session_id, tenant_id, value, comment, user_id, created_at, updated_at`;

export class PostgresMessageFeedbackRepository implements AsyncMessageFeedbackStore {
  constructor(private readonly executor: PostgresExecutor) {}

  /** 幂等 upsert：每条消息至多一条反馈，后写覆盖（含评价人与评论），created_at 保留首次时间。 */
  async setMessageFeedback(input: {
    sessionId: string;
    messageId: string;
    tenantId: TenantId;
    value: MessageFeedbackValue;
    comment?: string | null;
    userId?: string | null;
  }): Promise<MessageFeedback> {
    const comment = input.comment?.trim() ? input.comment.trim() : null;
    const result = await this.executor.query<FeedbackRow>(
      `INSERT INTO conversation_message_feedback (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (message_id) DO UPDATE SET
         value = EXCLUDED.value,
         comment = EXCLUDED.comment,
         user_id = EXCLUDED.user_id,
         updated_at = CURRENT_TIMESTAMP
       RETURNING ${COLUMNS}`,
      [
        input.messageId,
        input.sessionId,
        input.tenantId,
        input.value,
        comment,
        input.userId ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`message feedback upsert returned no row: ${input.messageId}`);
    return toFeedback(row);
  }

  async clearMessageFeedback(input: { sessionId: string; messageId: string }): Promise<boolean> {
    const result = await this.executor.query(
      "DELETE FROM conversation_message_feedback WHERE message_id=$1 AND session_id=$2",
      [input.messageId, input.sessionId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listMessageFeedback(sessionId: string): Promise<MessageFeedback[]> {
    const result = await this.executor.query<FeedbackRow>(
      `SELECT ${COLUMNS} FROM conversation_message_feedback
       WHERE session_id=$1 ORDER BY updated_at DESC`,
      [sessionId],
    );
    return result.rows.map(toFeedback);
  }

  async listNegativeMessageFeedback(
    tenantId: TenantId,
    options?: { since?: string; limit?: number },
  ): Promise<MessageFeedback[]> {
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const result = options?.since
      ? await this.executor.query<FeedbackRow>(
          `SELECT ${COLUMNS} FROM conversation_message_feedback
           WHERE tenant_id=$1 AND value='down' AND updated_at >= $2::timestamptz
           ORDER BY updated_at DESC LIMIT $3`,
          [tenantId, options.since, limit],
        )
      : await this.executor.query<FeedbackRow>(
          `SELECT ${COLUMNS} FROM conversation_message_feedback
           WHERE tenant_id=$1 AND value='down'
           ORDER BY updated_at DESC LIMIT $2`,
          [tenantId, limit],
        );
    return result.rows.map(toFeedback);
  }
}
