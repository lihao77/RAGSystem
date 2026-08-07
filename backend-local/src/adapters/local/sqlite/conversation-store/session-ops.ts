import type {
  CreateSessionRecordInput,
  SessionFacetCounts,
  SessionInfo,
  SessionListProjectionPage,
  SessionListQuery,
} from "@ragsystem/backend-core/contracts/session/session.js";
import { normalizeSessionMetadata } from "@ragsystem/backend-core/contracts/session/session.js";
import type { PermissionMode } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { deepMergeRecords } from "./shared/primitives.js";
import { isoTimestampToSqlite, stringifyJson } from "./helpers.js";
import { rowToSession, rowToSessionListProjection } from "./mappers.js";
import type { SessionListProjectionRow, SessionRow } from "./types.js";
import { SessionListProjector } from "./session-list-projector.js";

export class SessionOps {
  constructor(
    private readonly db: ConversationDb,
    private readonly projector: SessionListProjector,
  ) {}

  createSession(input: CreateSessionRecordInput): void {
    runInTransaction(this.db, () => this.createSessionInTransaction(input));
  }

  createSessionInTransaction(input: CreateSessionRecordInput): void {
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    const result = this.db.prepare(`
        INSERT INTO sessions (
          session_id, tenant_id, owner_user_id, visibility, origin_type, origin_id,
          origin_channel, workspace_id, permission_mode, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO NOTHING
    `).run(
        input.sessionId,
        input.tenantId,
        input.ownerUserId,
        input.visibility,
        input.originType,
        input.originId,
        input.originChannel,
        input.workspaceId,
        input.permissionMode ?? null,
        stringifyJson(metadata),
    );
    const persisted = this.getSession(input.sessionId);
    if (!persisted) throw new Error(`Session insert returned no row: ${input.sessionId}`);
    const identityConflict = persisted.tenant_id !== input.tenantId
      || persisted.owner_user_id !== input.ownerUserId
      || persisted.visibility !== input.visibility
      || persisted.origin_type !== input.originType
      || persisted.origin_id !== input.originId
      || persisted.origin_channel !== input.originChannel
      || persisted.workspace_id !== input.workspaceId;
    if (identityConflict) throw new Error(`Session immutable identity conflict: ${input.sessionId}`);
    if (Number(result.changes) > 0) this.projector.rebuildSessionListProjection(input.sessionId);
  }

  getSession(sessionId: string): SessionInfo | null {
    const row = this.db.prepare(`
      SELECT session_id, tenant_id, owner_user_id, visibility, origin_type, origin_id,
             origin_channel, workspace_id, permission_mode, metadata, created_at, updated_at
      FROM sessions WHERE session_id=?
    `).get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Record<string, unknown> | null {
    return runInTransaction(this.db, () => this.updateSessionMetadataInTransaction(sessionId, patch));
  }

  updateSessionMetadataInTransaction(sessionId: string, patch: Record<string, unknown>): Record<string, unknown> | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const metadata = normalizeSessionMetadata(deepMergeRecords(session.metadata, patch));
    this.db.prepare("UPDATE sessions SET metadata=?, updated_at=CURRENT_TIMESTAMP WHERE session_id=?")
      .run(stringifyJson(metadata), sessionId);
    return metadata;
  }

  updateSessionPermissionMode(sessionId: string, mode: PermissionMode): boolean {
    const result = this.db.prepare("UPDATE sessions SET permission_mode=?, updated_at=CURRENT_TIMESTAMP WHERE session_id=?")
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

  listSessions(input: SessionListQuery): SessionListProjectionPage {
    const limit = Math.max(1, Math.min(100, input.limit));
    const clauses = ["tenant_id=?", visibilityClause(input.access.includeTenant, input.access.includeAll === true)];
    const params: Array<string | number | null> = [input.tenantId, ...(input.access.includeAll ? [] : [input.access.userId])];
    if (input.originType) { clauses.push("origin_type=?"); params.push(input.originType); }
    if (input.originId) { clauses.push("origin_id=?"); params.push(input.originId); }
    if (input.workspaceId === "__unassigned__") clauses.push("workspace_id IS NULL");
    else if (input.workspaceId) { clauses.push("workspace_id=?"); params.push(input.workspaceId); }
    if (input.cursor) {
      clauses.push("(activity_at < ? OR (activity_at = ? AND session_id < ?))");
      const cursorActivityAt = isoTimestampToSqlite(input.cursor.activityAt);
      params.push(cursorActivityAt, cursorActivityAt, input.cursor.sessionId);
    }
    const rows = this.db.prepare(`
      SELECT session_id, tenant_id, owner_user_id, visibility, origin_type, origin_id,
             origin_channel, workspace_id, title, first_message, last_message, activity_at, unread_count
      FROM session_list_projection
      WHERE ${clauses.join(" AND ")}
      ORDER BY activity_at DESC, session_id DESC
      LIMIT ?
    `).all(...params, limit + 1) as unknown as SessionListProjectionRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(rowToSessionListProjection);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? { activityAt: last.activity_at, sessionId: last.session_id } : null,
    };
  }

  listSessionFacets(input: Pick<SessionListQuery, "tenantId" | "access">): SessionFacetCounts {
    const where = `tenant_id=? AND ${visibilityClause(input.access.includeTenant, input.access.includeAll === true)}`;
    const params = [input.tenantId, ...(input.access.includeAll ? [] : [input.access.userId])];
    const types = this.db.prepare(`SELECT origin_type AS type, COUNT(*) AS count FROM session_list_projection WHERE ${where} GROUP BY origin_type`)
      .all(...params) as Array<{ type: "direct" | "bot" | "widget"; count: number }>;
    const origins = this.db.prepare(`
      SELECT origin_type AS type, origin_id AS id, COUNT(*) AS count
      FROM session_list_projection WHERE ${where} AND origin_type != 'direct'
      GROUP BY origin_type, origin_id ORDER BY origin_type, origin_id
    `).all(...params) as Array<{ type: "bot" | "widget"; id: string; count: number }>;
    const workspaces = this.db.prepare(`
      SELECT workspace_id AS workspaceId, COUNT(*) AS count
      FROM session_list_projection WHERE ${where} AND workspace_id IS NOT NULL
      GROUP BY workspace_id ORDER BY workspace_id
    `).all(...params) as Array<{ workspaceId: string; count: number }>;
    const typeCounts = { direct: 0, bot: 0, widget: 0 };
    for (const row of types) typeCounts[row.type] = Number(row.count);
    return { typeCounts, origins: origins.map((row) => ({ ...row, count: Number(row.count) })), workspaces: workspaces.map((row) => ({ ...row, count: Number(row.count) })) };
  }
}

function visibilityClause(includeTenant: boolean, includeAll: boolean): string {
  if (includeAll) return "1=1";
  return includeTenant
    ? "((visibility='private' AND owner_user_id=?) OR visibility='tenant')"
    : "(visibility='private' AND owner_user_id=?)";
}
