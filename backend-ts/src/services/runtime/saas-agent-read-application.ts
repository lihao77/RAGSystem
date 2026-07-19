import type { OutboxRow, RunInfo } from "../../contracts/conversation-store/index.js";
import type { ExecutionOverview, ExecutionTaskStatus, RunningTasksResult, ScopedExecutionDiagnostics, ScopedTaskStatus, SessionTaskStatus } from "../../contracts/execution.js";
import type { SessionInfo } from "../../contracts/session.js";
import type { PostgresConversationRepository } from "../../adapters/saas/postgres/conversation-repository.js";
import type { PostgresOutboxRepository } from "../../adapters/saas/postgres/outbox-repository.js";
import type { PostgresRunRepository } from "../../adapters/saas/postgres/run-repository.js";
import { buildObservability } from "../agent/execution/helpers.js";

/** Tenant-bound read facade used while the Agent execution path is still being made fully asynchronous. */
export class SaaSAgentReadApplication {
  constructor(
    private readonly tenantId: string,
    private readonly conversations: Pick<PostgresConversationRepository, "getSession">,
    private readonly runs: Pick<PostgresRunRepository, "listRuns" | "getTenantRun" | "listTenantRuns">,
    private readonly outbox: Pick<PostgresOutboxRepository, "listOutboxForReplay">,
  ) {}

  async getSession(sessionId: string): Promise<SessionInfo | null> {
    const session = await this.conversations.getSession(sessionId);
    return session?.tenant_id === this.tenantId ? session : null;
  }

  async getSessionTaskStatus(sessionId: string): Promise<SessionTaskStatus> {
    if (!(await this.getSession(sessionId))) return idleStatus(sessionId);
    const latest = (await this.runs.listRuns(this.tenantId, sessionId, 500)).items[0] ?? null;
    if (!latest) return idleStatus(sessionId);
    const task = toTaskStatus(latest);
    return {
      session_id: sessionId,
      has_running_task: latest.status === "running",
      has_active_system_command: false,
      task_info: task,
      observability: null,
      diagnostics: null,
    };
  }

  async listRuns(sessionId: string, limit = 500): Promise<RunInfo[]> {
    if (!(await this.getSession(sessionId))) return [];
    return (await this.runs.listRuns(this.tenantId, sessionId, limit)).items;
  }

  async listOutboxForReplay(input: { sessionId: string; runIds?: readonly string[]; afterSeq?: number; limit?: number }): Promise<OutboxRow[]> {
    if (!(await this.getSession(input.sessionId))) return [];
    return this.outbox.listOutboxForReplay({ tenantId: this.tenantId, ...input });
  }

  async getSessionExecutionDiagnostics(sessionId: string): Promise<ScopedExecutionDiagnostics> {
    if (!(await this.getSession(sessionId))) return missingDiagnostics("session_id", sessionId);
    const latest = (await this.runs.listRuns(this.tenantId, sessionId, 1)).items[0] ?? null;
    return latest ? runDiagnostics("session_id", sessionId, latest) : missingDiagnostics("session_id", sessionId);
  }

  async getTaskStatus(taskId: string): Promise<ScopedTaskStatus> {
    const row = await this.runs.getTenantRun(this.tenantId, taskId);
    const task = row ? toTaskStatus(row) : null;
    return {
      task_id: taskId, scope: "task_id", scope_id: taskId, found: task !== null,
      has_running_task: task?.status === "running", task_info: task,
      observability: task ? buildObservability(task) : null,
    };
  }

  async getTaskExecutionDiagnostics(taskId: string): Promise<ScopedExecutionDiagnostics> {
    const row = await this.runs.getTenantRun(this.tenantId, taskId);
    return row ? runDiagnostics("task_id", taskId, row) : missingDiagnostics("task_id", taskId);
  }

  async listRunningTasks(): Promise<RunningTasksResult> {
    const items = (await this.runs.listTenantRuns(this.tenantId, true)).map(toTaskStatus);
    return { active_only: true, count: items.length, items };
  }

  async getOverview(activeOnly: boolean): Promise<ExecutionOverview> {
    const items = (await this.runs.listTenantRuns(this.tenantId, activeOnly)).map(toTaskStatus);
    const byExecutionKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const sessions: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      byExecutionKind[item.execution_kind] = (byExecutionKind[item.execution_kind] ?? 0) + 1;
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      if (item.session_id && !seen.has(item.session_id)) { seen.add(item.session_id); sessions.push(item.session_id); }
    }
    return { active_only: activeOnly, count: items.length, by_execution_kind: byExecutionKind, by_status: byStatus, sessions, items };
  }
}

function idleStatus(sessionId: string): SessionTaskStatus {
  return { session_id: sessionId, has_running_task: false, has_active_system_command: false, task_info: null, observability: null, diagnostics: null };
}

function toTaskStatus(run: RunInfo): ExecutionTaskStatus {
  const running = run.status === "running";
  return {
    task_id: run.run_id,
    session_id: run.session_id,
    run_id: run.run_id,
    request_id: run.request_id,
    execution_kind: run.entrypoint ?? "execute",
    task: run.task_summary ?? "",
    status: run.status,
    elapsed_seconds: null,
    started_at: run.created_at,
    finished_at: running ? null : run.updated_at,
    thread_alive: running,
  };
}

function missingDiagnostics(scope: "session_id" | "task_id", id: string): ScopedExecutionDiagnostics {
  return { ...(scope === "session_id" ? { session_id: id } : { task_id: id }), scope, scope_id: id, found: false, diagnostics: null };
}

function runDiagnostics(scope: "session_id" | "task_id", id: string, run: RunInfo): ScopedExecutionDiagnostics {
  const task = toTaskStatus(run);
  return {
    ...(scope === "session_id" ? { session_id: id } : { task_id: id }), scope, scope_id: id, found: true,
    diagnostics: { task, runner: null, observability: buildObservability(task), handle_registered: false, is_running: task.status === "running" },
  };
}
