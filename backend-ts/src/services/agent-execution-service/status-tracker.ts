import type {
  ExecutionDiagnostics,
  ExecutionOverview,
  ExecutionTaskStatus,
  RunningTasksResult,
  ScopedExecutionDiagnostics,
  ScopedTaskStatus,
  SessionTaskStatus,
} from "../../contracts/execution.js";
import { buildObservability, cloneStatus } from "./helpers.js";

export interface ExecutionHandle {
  abortController: AbortController;
  status: ExecutionTaskStatus;
  promise: Promise<void>;
}

export class AgentExecutionStatusTracker {
  private readonly handlesByTask = new Map<string, ExecutionHandle>();
  private readonly taskBySession = new Map<string, string>();
  private readonly statusHistory = new Map<string, ExecutionTaskStatus>();

  register(taskId: string, sessionId: string, handle: ExecutionHandle): void {
    this.handlesByTask.set(taskId, handle);
    this.taskBySession.set(sessionId, taskId);
    this.statusHistory.set(taskId, handle.status);
  }

  unregister(taskId: string, sessionId: string): void {
    this.taskBySession.delete(sessionId);
    this.handlesByTask.delete(taskId);
  }

  getRunningHandleBySession(sessionId: string): ExecutionHandle | null {
    const taskId = this.taskBySession.get(sessionId);
    if (!taskId) {
      return null;
    }
    const handle = this.handlesByTask.get(taskId);
    return handle?.status.status === "running" ? handle : null;
  }

  getSessionTaskStatus(sessionId: string): SessionTaskStatus {
    const status = this.getStatusBySession(sessionId);
    const diagnostics = status ? this.buildDiagnostics(status) : null;
    return {
      session_id: sessionId,
      has_running_task: status?.status === "running",
      has_active_system_command: false,
      task_info: status,
      observability: status ? buildObservability(status) : null,
      diagnostics,
    };
  }

  getSessionExecutionDiagnostics(sessionId: string): ScopedExecutionDiagnostics {
    const status = this.getStatusBySession(sessionId);
    return {
      session_id: sessionId,
      scope: "session_id",
      scope_id: sessionId,
      found: status !== null,
      diagnostics: status ? this.buildDiagnostics(status) : null,
    };
  }

  getTaskStatus(taskId: string): ScopedTaskStatus {
    const status = this.getStatus(taskId);
    return {
      task_id: taskId,
      scope: "task_id",
      scope_id: taskId,
      found: status !== null,
      has_running_task: status?.status === "running",
      task_info: status,
      observability: status ? buildObservability(status) : null,
    };
  }

  getTaskExecutionDiagnostics(taskId: string): ScopedExecutionDiagnostics {
    const status = this.getStatus(taskId);
    return {
      task_id: taskId,
      scope: "task_id",
      scope_id: taskId,
      found: status !== null,
      diagnostics: status ? this.buildDiagnostics(status) : null,
    };
  }

  listRunningTasks(): RunningTasksResult {
    const items = this.listStatuses(true);
    return {
      active_only: true,
      count: items.length,
      items,
    };
  }

  getOverview(activeOnly: boolean): ExecutionOverview {
    const items = this.listStatuses(activeOnly);
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

  getStatusBySession(sessionId: string): ExecutionTaskStatus | null {
    const runningTaskId = this.taskBySession.get(sessionId);
    if (runningTaskId) {
      return this.getStatus(runningTaskId);
    }
    const latest = Array.from(this.statusHistory.values())
      .filter((status) => status.session_id === sessionId)
      .sort((left, right) => String(right.started_at ?? "").localeCompare(String(left.started_at ?? "")))[0];
    return cloneStatus(latest ?? null);
  }

  finishStatus(status: ExecutionTaskStatus, finalStatus: string, startedAt: Date): void {
    const finishedAt = new Date();
    status.status = finalStatus;
    status.finished_at = finishedAt.toISOString();
    status.elapsed_seconds = (finishedAt.getTime() - startedAt.getTime()) / 1000;
    status.thread_alive = false;
  }

  private getStatus(taskId: string): ExecutionTaskStatus | null {
    return cloneStatus(this.statusHistory.get(taskId) ?? null);
  }

  private listStatuses(activeOnly: boolean): ExecutionTaskStatus[] {
    return Array.from(this.statusHistory.values())
      .filter((status) => !activeOnly || status.status === "running")
      .map((status) => ({ ...status }))
      .sort((left, right) => String(right.started_at ?? "").localeCompare(String(left.started_at ?? "")));
  }

  private buildDiagnostics(status: ExecutionTaskStatus): ExecutionDiagnostics {
    return {
      task: status,
      runner: null,
      observability: buildObservability(status),
      handle_registered: false,
      is_running: status.status === "running",
    };
  }
}
