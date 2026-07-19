import type { PaginatedResult } from "../../../../contracts/common.js";
import type { SessionInfo, SessionListItem } from "../../../../contracts/session.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { deepMergeRecords } from "./shared/primitives.js";
import { stringifyJson } from "./helpers.js";
import { rowToSession, rowToSessionListItem } from "./mappers.js";
import type { ISessionStore } from "../../../../contracts/conversation-store/index.js";
import type { SessionListRow, SessionRow } from "./types.js";
import type { TenantId } from "../../../../identity/types.js";
import type { PermissionMode } from "../../../../contracts/permissions.js";

/** sessions 聚合根操作（迁移自 ConversationStore，方法体零改动）。 */
export class SessionOps implements ISessionStore {
  constructor(private readonly db: ConversationDb) {}

  createSession(
    tenantId: TenantId,
    sessionId: string,
    userId: string | null,
    metadata: Record<string, unknown> = {},
    permissionMode: PermissionMode | null = null,
  ): void {
    this.db
      .prepare(`
        INSERT INTO sessions (session_id, tenant_id, user_id, permission_mode, metadata)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          tenant_id=excluded.tenant_id,
          user_id=excluded.user_id,
          permission_mode=COALESCE(sessions.permission_mode, excluded.permission_mode),
          metadata=excluded.metadata,
          updated_at=CURRENT_TIMESTAMP
      `)
      .run(sessionId, tenantId, userId, permissionMode, stringifyJson(metadata));
  }

  getSession(sessionId: string): SessionInfo | null {
    const row = this.db
      .prepare("SELECT session_id, tenant_id, user_id, permission_mode, metadata, created_at, updated_at FROM sessions WHERE session_id=?")
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

  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): boolean {
    const result = this.db
      .prepare("UPDATE sessions SET permission_mode=?, updated_at=CURRENT_TIMESTAMP WHERE session_id=?")
      .run(mode, sessionId);
    return Number(result.changes) > 0;
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

  listSessions(tenantId: TenantId, limit = 20, offset = 0, userIds?: readonly string[] | null): PaginatedResult<SessionListItem> {
    const resolvedUserIds = userIds?.map((userId) => userId.trim()).filter(Boolean) ?? null;
    if (resolvedUserIds && resolvedUserIds.length === 0) {
      return { items: [], total: 0, limit, offset, has_more: false };
    }
    const ownerClause = resolvedUserIds ? ` AND user_id IN (${resolvedUserIds.map(() => "?").join(", ")})` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(1) AS cnt FROM sessions WHERE tenant_id=?${ownerClause}`)
      .get(tenantId, ...(resolvedUserIds ?? [])) as { cnt: number };
    const rows = this.db
      .prepare(`
        SELECT
          s.session_id,
          s.tenant_id,
          s.user_id,
          s.permission_mode,
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
        WHERE s.tenant_id=?${ownerClause}
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(tenantId, ...(resolvedUserIds ?? []), limit, offset) as unknown as SessionListRow[];

    return {
      items: rows.map(rowToSessionListItem),
      total: totalRow.cnt,
      limit,
      offset,
      has_more: offset + limit < totalRow.cnt,
    };
  }
}
