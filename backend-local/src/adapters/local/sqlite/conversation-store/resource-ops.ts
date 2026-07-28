import { randomUUID } from "node:crypto";
import type { ExecutionOverview, ExecutionTaskStatus } from "@ragsystem/backend-core/contracts/execution/execution.js";
import type { ConversationDb } from "./shared/db.js";
import type { SessionOps } from "./session-ops.js";
import type { WorkspaceOps } from "./workspace-ops.js";
import { stringifyJson } from "./helpers.js";
import { rowToResource } from "./mappers.js";
import { inferResourceScope } from "./resource-scope.js";
import type { ResourceInfo } from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { ResourceRow } from "./types.js";

/** resources + step_resources 聚合根操作 + 执行投影（迁移自 ConversationStore，方法体零改动）。 */
export class ResourceOps {
  constructor(
    private readonly db: ConversationDb,
    private readonly dataRoot: string,
    private readonly sessionOps: SessionOps,
    private readonly workspaceOps: WorkspaceOps,
  ) {}

  getPersistedExecutionOverview(activeOnly: boolean, limit = 200): ExecutionOverview {
    const rows = this.db
      .prepare(
        `
          SELECT run_id, session_id, entrypoint, status, task_summary, request_id,
                 created_at, updated_at
          FROM runs
          WHERE (? = 0 OR status = 'running')
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(activeOnly ? 1 : 0, limit) as Array<{
        run_id: string;
        session_id: string;
        entrypoint: string | null;
        status: string;
        task_summary: string | null;
        request_id: string | null;
        created_at: string | null;
        updated_at: string | null;
      }>;
    const items: Array<ExecutionTaskStatus & { raw_status: string; timeout_seconds: null; waiting_status: null; pending_wait_ids: [] }> = [];
    for (const row of rows) {
      items.push({
        task_id: row.run_id,
        session_id: row.session_id,
        run_id: row.run_id,
        request_id: row.request_id,
        execution_kind: row.entrypoint ?? "agent_stream",
        task: row.task_summary ?? "",
        status: row.status,
        raw_status: row.status,
        elapsed_seconds: null,
        started_at: row.created_at,
        finished_at: row.status === "running" ? null : row.updated_at,
        thread_alive: row.status === "running",
        timeout_seconds: null,
        waiting_status: null,
        pending_wait_ids: [],
      });
    }
    const byExecutionKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const sessions: string[] = [];
    const seenSessions = new Set<string>();
    for (const item of items) {
      byExecutionKind[item.execution_kind] = (byExecutionKind[item.execution_kind] ?? 0) + 1;
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      if (item.session_id && !seenSessions.has(item.session_id)) {
        seenSessions.add(item.session_id);
        sessions.push(item.session_id);
      }
    }
    return {
      active_only: activeOnly,
      count: items.length,
      by_execution_kind: byExecutionKind,
      by_status: byStatus,
      sessions,
      items,
    };
  }

  registerResource(input: {
    sessionId: string;
    path: string;
    resourceType: string;
    sourceTool?: string;
    runId?: string | null;
    stepId?: number | null;
    messageId?: string | null;
    subType?: string | null;
    title?: string | null;
    scope?: string | null;
    metadata?: Record<string, unknown>;
  }): {
    resource_id: string;
    session_id: string;
    path: string;
    scope: string;
    resource_type: string;
  } {
    const resourceId = randomUUID();
    const session = this.sessionOps.getSession(input.sessionId);
    const workspaceRoot = session?.workspace_id
      ? this.workspaceOps.getById(session.tenant_id, session.workspace_id)?.root_path ?? null
      : null;
    const scope = input.scope ?? inferResourceScope({
      dataRoot: this.dataRoot,
      resourcePath: input.path,
      workspaceRoot,
    });
    this.db
      .prepare(
        `
          INSERT INTO resources
          (resource_id, session_id, run_id, step_id, message_id,
           resource_type, sub_type, title, path, source_tool, scope, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        resourceId,
        input.sessionId,
        input.runId ?? null,
        input.stepId ?? null,
        input.messageId ?? null,
        input.resourceType,
        input.subType ?? null,
        input.title ?? null,
        input.path,
        input.sourceTool ?? "",
        scope,
        stringifyJson(input.metadata ?? {}),
      );
    return {
      resource_id: resourceId,
      session_id: input.sessionId,
      path: input.path,
      scope,
      resource_type: input.resourceType,
    };
  }

  listResources(sessionId: string, runId?: string | null, limit = 100): { items: ResourceInfo[]; total: number } {
    const totalRow = runId
      ? (this.db
          .prepare("SELECT COUNT(1) AS cnt FROM resources WHERE session_id=? AND run_id=?")
          .get(sessionId, runId) as { cnt: number })
      : (this.db
          .prepare("SELECT COUNT(1) AS cnt FROM resources WHERE session_id=?")
          .get(sessionId) as { cnt: number });
    const rows = runId
      ? (this.db
          .prepare("SELECT * FROM resources WHERE session_id=? AND run_id=? ORDER BY created_at DESC LIMIT ?")
          .all(sessionId, runId, limit) as unknown as ResourceRow[])
      : (this.db
          .prepare("SELECT * FROM resources WHERE session_id=? ORDER BY created_at DESC LIMIT ?")
          .all(sessionId, limit) as unknown as ResourceRow[]);
    const items = rows.map(rowToResource);
    return { items, total: totalRow.cnt };
  }

  attachResourceToStep(sessionId: string, runId: string, stepId: number, resourceId: string): void {
    this.db
      .prepare(
        `
          INSERT OR IGNORE INTO step_resources (step_id, resource_id, session_id, run_id)
          VALUES (?, ?, ?, ?)
        `,
      )
      .run(stepId, resourceId, sessionId, runId);
  }
}
