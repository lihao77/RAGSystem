import type { ExecutionOverview, ExecutionTaskStatus } from "@ragsystem/backend-core/contracts/execution/execution.js";
import type { ConversationDb } from "./shared/db.js";
import { rowToRun } from "./mappers.js";
import type {
  CreatedRun,
  CreateRunInput,
  RunInfo,
} from "@ragsystem/backend-core/contracts/conversation-store/index.js";
import type { RunRow } from "./types.js";

/** runs 聚合根操作（迁移自 ConversationStore，方法体零改动）。run_steps/boundaries 归档与 resources 表已退役。 */
export class RunOps {
  constructor(private readonly db: ConversationDb) {}

  createRun(input: CreateRunInput): CreatedRun {
    const threadKey = input.threadKey?.trim() || "root";
    const status = input.status ?? "running";
    this.db
      .prepare(
        `
          INSERT INTO runs (
            run_id, session_id, tenant_id, entrypoint, status, task_summary,
            request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
            agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id, child_agent_id
          )
          SELECT ?, session_id, tenant_id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          FROM sessions
          WHERE session_id=?
        `,
      )
      .run(
        input.runId,
        input.entrypoint ?? "execute",
        status,
        input.taskSummary ?? "",
        input.requestId ?? null,
        input.userId ?? null,
        input.agentName ?? null,
        input.agentCallId,
        input.lineageParentCallId,
        input.agentDisplayName,
        input.leaseRootRunId,
        threadKey,
        input.parentRunId ?? null,
        input.parentCallId ?? null,
        input.childAgentId ?? null,
        input.sessionId,
      );
    return {
      run_id: input.runId,
      session_id: input.sessionId,
      status,
      thread_key: threadKey,
      parent_run_id: input.parentRunId ?? null,
      parent_call_id: input.parentCallId ?? null,
      agent_call_id: input.agentCallId,
      lineage_parent_call_id: input.lineageParentCallId,
      agent_display_name: input.agentDisplayName,
      lease_root_run_id: input.leaseRootRunId,
      child_agent_id: input.childAgentId ?? null,
    };
  }

  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId: string | null = null, terminalReason: string | null = null): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE runs
          SET status=?, final_message_id=?, terminal_reason=?, updated_at=CURRENT_TIMESTAMP
          WHERE run_id=? AND session_id=?
        `,
      )
      .run(status, finalMessageId, terminalReason, runId, sessionId);
    return Number(result.changes) > 0;
  }

  getRun(sessionId: string, runId: string): RunInfo | null {
    const row = this.db
      .prepare(
        `
          SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                 request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                 agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                 child_agent_id, final_message_id, created_at, updated_at
          FROM runs
          WHERE session_id=? AND run_id=?
        `,
      )
      .get(sessionId, runId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(sessionId: string, limit = 50, offset = 0): { items: RunInfo[]; total: number } {
    const totalRow = this.db
      .prepare("SELECT COUNT(1) AS cnt FROM runs WHERE session_id=?")
      .get(sessionId) as { cnt: number };
    const rows = this.db
      .prepare(
        `
          SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                 request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                 agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                 child_agent_id, final_message_id, created_at, updated_at
          FROM runs
          WHERE session_id=?
          ORDER BY created_at DESC, run_id DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(sessionId, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset))) as unknown as RunRow[];
    const items = rows.map(rowToRun);
    return { items, total: totalRow.cnt };
  }

  listParticipantRuns(sessionId: string, participantId: string, limit: number, offset: number): { items: RunInfo[]; total: number } {
    const participantWhere = participantId === "root"
      ? "child_agent_id IS NULL AND thread_key='root'"
      : "child_agent_id=?";
    const identityParams = participantId === "root" ? [sessionId] : [sessionId, participantId];
    const totalRow = this.db
      .prepare(`SELECT COUNT(1) AS cnt FROM runs WHERE session_id=? AND ${participantWhere}`)
      .get(...identityParams) as { cnt: number };
    const rows = this.db
      .prepare(
        `
          SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
                 request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
                 agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
                 child_agent_id, final_message_id, created_at, updated_at
          FROM runs
          WHERE session_id=? AND ${participantWhere}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
        `,
      )
      .all(...identityParams, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(offset))) as unknown as RunRow[];
    return { items: rows.map(rowToRun), total: totalRow.cnt };
  }

  listActiveRootRuns(sessionId: string, limit = 2): RunInfo[] {
    const rows = this.db.prepare(`
      SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
             request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
             agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
             child_agent_id, final_message_id, created_at, updated_at
      FROM runs
      WHERE session_id=? AND parent_run_id IS NULL AND child_agent_id IS NULL
        AND status IN ('running', 'suspended')
      ORDER BY updated_at DESC, created_at DESC, run_id DESC
      LIMIT ?
    `).all(sessionId, limit) as unknown as RunRow[];
    return rows.map(rowToRun);
  }

  getLatestTerminalRootRun(sessionId: string): RunInfo | null {
    const row = this.db.prepare(`
      SELECT run_id, session_id, tenant_id, entrypoint, status, task_summary, terminal_reason,
             request_id, user_id, agent_name, agent_call_id, lineage_parent_call_id,
             agent_display_name, lease_root_run_id, thread_key, parent_run_id, parent_call_id,
             child_agent_id, final_message_id, created_at, updated_at
      FROM runs
      WHERE session_id=? AND parent_run_id IS NULL AND child_agent_id IS NULL
        AND status IN ('completed', 'failed', 'interrupted')
      ORDER BY updated_at DESC, created_at DESC, run_id DESC
      LIMIT 1
    `).get(sessionId) as RunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  /** 持久执行总览（runs 表投影；迁自 resource-ops，与已退役的 resources 表无关）。 */
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
}
