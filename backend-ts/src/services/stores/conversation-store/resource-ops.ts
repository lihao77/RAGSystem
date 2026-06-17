import { randomUUID } from "node:crypto";
import type { ExecutionOverview, ExecutionTaskStatus } from "../../../contracts/execution.js";
import type { ConversationDb } from "./shared/db.js";
import type { SessionOps } from "./session-ops.js";
import { asNullableString, parseJsonObject, stringifyJson } from "./helpers.js";
import { rowToResource } from "./mappers.js";
import { inferResourceScope } from "./resource-scope.js";
import { isRecord } from "./shared/primitives.js";
import type { ResourceInfo, ResourceRow } from "./types.js";

/** resources + step_resources 聚合根操作 + 执行投影（迁移自 ConversationStore，方法体零改动）。 */
export class ResourceOps {
  constructor(
    private readonly db: ConversationDb,
    private readonly dataRoot: string,
    private readonly sessionOps: SessionOps,
  ) {}

  getPersistedExecutionOverview(activeOnly: boolean, limit = 200): ExecutionOverview {
    const rows = this.db
      .prepare(
        `
          SELECT event_type, payload, created_at, delivered_at
          FROM event_outbox
          WHERE event_type IN (
            'execution.step_recorded',
            'agent.call_finished',
            'agent.call_failed',
            'run.final_answer_recorded'
          )
          ORDER BY id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{ event_type: string; payload: string; created_at: string | null; delivered_at: string | null }>;
    const byTask = new Map<string, ExecutionTaskStatus & { raw_status: string; timeout_seconds: null; waiting_status: null; pending_wait_ids: [] }>();
    for (const row of rows) {
      const payload = parseJsonObject(row.payload);
      const execution = isRecord(payload._execution) ? payload._execution : payload;
      const taskId = asNullableString(execution.task_id) ?? asNullableString(payload.task_id) ?? asNullableString(payload.run_id);
      if (!taskId || byTask.has(taskId)) {
        continue;
      }
      const status = normalizePersistedExecutionStatus(payload, row.event_type);
      if (activeOnly && status !== "running") {
        continue;
      }
      byTask.set(taskId, {
        task_id: taskId,
        session_id: asNullableString(execution.session_id) ?? asNullableString(payload.session_id),
        run_id: asNullableString(execution.run_id) ?? asNullableString(payload.run_id),
        request_id: asNullableString(execution.request_id) ?? asNullableString(payload.request_id),
        execution_kind: asNullableString(execution.execution_kind) ?? asNullableString(payload.execution_kind) ?? "agent_stream",
        task: asNullableString(payload.task) ?? asNullableString(payload.description) ?? "",
        status,
        raw_status: status,
        elapsed_seconds: typeof payload.execution_time === "number" ? payload.execution_time : null,
        started_at: row.created_at,
        finished_at: status === "running" ? null : row.delivered_at ?? row.created_at,
        thread_alive: status === "running",
        timeout_seconds: null,
        waiting_status: null,
        pending_wait_ids: [],
      });
    }
    const items = Array.from(byTask.values());
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
    const scope = input.scope ?? inferResourceScope({
      dataRoot: this.dataRoot,
      resourcePath: input.path,
      sessionMetadata: this.sessionOps.getSession(input.sessionId)?.metadata,
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
    const rows = runId
      ? (this.db
          .prepare("SELECT * FROM resources WHERE session_id=? AND run_id=? ORDER BY created_at DESC LIMIT ?")
          .all(sessionId, runId, limit) as unknown as ResourceRow[])
      : (this.db
          .prepare("SELECT * FROM resources WHERE session_id=? ORDER BY created_at DESC LIMIT ?")
          .all(sessionId, limit) as unknown as ResourceRow[]);
    const items = rows.map(rowToResource);
    return { items, total: items.length };
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

function normalizePersistedExecutionStatus(payload: Record<string, unknown>, eventType: string): string {
  const status = asNullableString(payload.status);
  if (status) {
    return status;
  }
  if (eventType === "agent.call_failed") {
    return "failed";
  }
  if (eventType === "execution.step_recorded") {
    const step = isRecord(payload.step) ? payload.step : payload;
    const stepStatus = asNullableString(step.status);
    if (stepStatus) {
      return stepStatus;
    }
  }
  return "completed";
}
