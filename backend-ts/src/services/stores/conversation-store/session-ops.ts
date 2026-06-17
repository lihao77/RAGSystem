import type { PaginatedResult } from "../../../contracts/common.js";
import type { SessionInfo, SessionListItem } from "../../../contracts/session.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { deepMergeRecords } from "./shared/primitives.js";
import { stringifyJson } from "./helpers.js";
import { rowToSession, rowToSessionListItem } from "./mappers.js";
import type { SessionRow, SessionListRow } from "./types.js";

/** sessions 聚合根操作（迁移自 ConversationStore，方法体零改动）。 */
export class SessionOps {
  constructor(private readonly db: ConversationDb) {}

  createSession(sessionId: string, userId: string | null = null, metadata: Record<string, unknown> = {}): void {
    this.db
      .prepare(`
        INSERT INTO sessions (session_id, user_id, metadata)
        VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          user_id=excluded.user_id,
          metadata=excluded.metadata,
          updated_at=CURRENT_TIMESTAMP
      `)
      .run(sessionId, userId, stringifyJson(metadata));
  }

  getSession(sessionId: string): SessionInfo | null {
    const row = this.db
      .prepare("SELECT session_id, user_id, metadata, created_at, updated_at FROM sessions WHERE session_id=?")
      .get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Record<string, unknown> | null {
    const session = this.getSession(sessionId);
    if (!session) {
      return null;
    }
    const metadata = deepMergeRecords(session.metadata, patch);
    this.db
      .prepare("UPDATE sessions SET metadata=?, updated_at=CURRENT_TIMESTAMP WHERE session_id=?")
      .run(stringifyJson(metadata), sessionId);
    return metadata;
  }

  deleteSession(sessionId: string): boolean {
    const result = runInTransaction(this.db, () => {
      this.db.prepare("DELETE FROM step_resources WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM resources WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM run_steps WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM runs WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM child_agents WHERE session_id=?").run(sessionId);
      return this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(sessionId);
    });
    return Number(result.changes) > 0;
  }

  listSessions(limit = 20, offset = 0, userId?: string | null): PaginatedResult<SessionListItem> {
    const resolvedUserId = userId?.trim() ? userId.trim() : null;
    const totalRow = this.db
      .prepare("SELECT COUNT(1) AS cnt FROM sessions WHERE (? IS NULL OR user_id = ?)")
      .get(resolvedUserId, resolvedUserId) as { cnt: number };
    const rows = this.db
      .prepare(`
        SELECT
          s.session_id,
          s.user_id,
          s.metadata,
          s.created_at,
          s.updated_at,
          (
            SELECT content
            FROM messages m
            WHERE m.session_id = s.session_id
            ORDER BY seq DESC
            LIMIT 1
          ) AS last_content,
          (
            SELECT created_at
            FROM messages m
            WHERE m.session_id = s.session_id
            ORDER BY seq DESC
            LIMIT 1
          ) AS last_created_at,
          (
            SELECT content
            FROM messages m
            WHERE m.session_id = s.session_id
            ORDER BY seq ASC
            LIMIT 1
          ) AS first_content
        FROM sessions s
        WHERE (? IS NULL OR s.user_id = ?)
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(resolvedUserId, resolvedUserId, limit, offset) as unknown as SessionListRow[];

    return {
      items: rows.map(rowToSessionListItem),
      total: totalRow.cnt,
      limit,
      offset,
      has_more: offset + limit < totalRow.cnt,
    };
  }
}
