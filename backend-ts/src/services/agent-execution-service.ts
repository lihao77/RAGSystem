import { randomUUID } from "node:crypto";

import type {
  AgentRunStartResult,
  ExecutionDiagnostics,
  ExecutionOverview,
  ExecutionObservability,
  ExecutionTaskStatus,
  RunningTasksResult,
  ScopedExecutionDiagnostics,
  ScopedTaskStatus,
  SessionTaskStatus,
  StreamExecuteRequest,
} from "../contracts/execution.js";
import { NotMigratedError } from "../utils/errors.js";
import type { AgentSessionApplication } from "./agent-session-application.js";
import type { InMemoryEventBus } from "./event-bus.js";

export class AgentExecutionService {
  constructor(
    private readonly sessions: AgentSessionApplication,
    private readonly events: InMemoryEventBus,
  ) {}

  async startStream(request: StreamExecuteRequest, requestId: string): Promise<AgentRunStartResult> {
    void requestId;
    const sessionId = request.session_id?.trim() || randomUUID();
    const task = request.task.trim();
    if (!task && request.attachments.length === 0) {
      return {
        started: false,
        session_id: sessionId,
        error: "Task and attachments cannot both be empty",
      };
    }

    throw new NotMigratedError("Agent stream execution");
  }

  async stopSession(sessionId: string): Promise<boolean> {
    void sessionId;
    void this.sessions;
    void this.events;
    return false;
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

  private getStatus(taskId: string): ExecutionTaskStatus | null {
    void taskId;
    return null;
  }

  private getStatusBySession(sessionId: string): ExecutionTaskStatus | null {
    void sessionId;
    return null;
  }

  private listStatuses(activeOnly: boolean): ExecutionTaskStatus[] {
    void activeOnly;
    return [];
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

function buildObservability(status: ExecutionTaskStatus): ExecutionObservability {
  return {
    task_id: status.task_id,
    session_id: status.session_id,
    run_id: status.run_id,
    execution_kind: status.execution_kind,
    request_id: status.request_id,
  };
}
