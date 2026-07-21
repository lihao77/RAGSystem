import type { OutboxRow, RunInfo } from "../../../../contracts/conversation-store/index.js";
import type { ExecutionOverview, RunningTasksResult, ScopedExecutionDiagnostics, ScopedTaskStatus, SessionTaskStatus } from "../../../../contracts/execution/execution.js";
import type { SessionInfo } from "../../../../contracts/session/session.js";
import type {
  ExecutionReadApplication,
} from "../../../../contracts/execution/execution-read-application.js";
import type {
  ExecutionReplayRepositoryPort,
  ExecutionRunReadRepositoryPort,
  ExecutionSessionReadRepositoryPort,
} from "../../../../contracts/storage/async-persistence-ports.js";
import { ExecutionReadProjector, type ExecutionReadLivePort } from "../../../../services/agent/execution/execution-read-projector.js";

/** Tenant-bound read facade used while the Agent execution path is still being made fully asynchronous. */
export class SaaSAgentReadApplication implements ExecutionReadApplication {
  private readonly projector: ExecutionReadProjector;
  constructor(
    private readonly tenantId: string,
    private readonly conversations: ExecutionSessionReadRepositoryPort,
    private readonly runs: ExecutionRunReadRepositoryPort,
    private readonly outbox: ExecutionReplayRepositoryPort,
    live: ExecutionReadLivePort = emptyLivePort,
  ) {
    this.projector = new ExecutionReadProjector(live, {
      getSession: (sessionId) => this.getSessionDurable(sessionId),
      listRuns: (sessionId, limit) => this.runs.listRuns(this.tenantId, sessionId, limit).then((result) => result.items),
      listOutboxForReplay: (input) => this.outbox.listOutboxForReplay({
        tenantId: this.tenantId,
        sessionId: input.sessionId,
        ...(input.runIds ? { runIds: input.runIds } : {}),
        ...(input.afterSeq != null ? { afterSeq: input.afterSeq } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
      listRunsForOverview: (activeOnly) => this.runs.listTenantRuns(this.tenantId, activeOnly),
      getRunByTaskId: (taskId) => this.runs.getTenantRun(this.tenantId, taskId),
    });
  }

  private async getSessionDurable(sessionId: string): Promise<SessionInfo | null> {
    const session = await this.conversations.getSession(sessionId);
    return session?.tenant_id === this.tenantId ? session : null;
  }

  async getSession(sessionId: string): Promise<SessionInfo | null> {
    return this.projector.getSession(sessionId);
  }

  async getSessionTaskStatus(sessionId: string): Promise<SessionTaskStatus> {
    return this.projector.getSessionTaskStatus(sessionId);
  }

  async listRuns(sessionId: string, limit = 500): Promise<RunInfo[]> {
    return this.projector.listRuns(sessionId, limit);
  }

  async listOutboxForReplay(input: { sessionId: string; runIds?: readonly string[]; afterSeq?: number; limit?: number }): Promise<OutboxRow[]> {
    return this.projector.listOutboxForReplay(input);
  }

  async getSessionExecutionDiagnostics(sessionId: string): Promise<ScopedExecutionDiagnostics> {
    return this.projector.getSessionExecutionDiagnostics(sessionId);
  }

  async getTaskStatus(taskId: string): Promise<ScopedTaskStatus> {
    return this.projector.getTaskStatus(taskId);
  }

  async getTaskExecutionDiagnostics(taskId: string): Promise<ScopedExecutionDiagnostics> {
    return this.projector.getTaskExecutionDiagnostics(taskId);
  }

  async listRunningTasks(): Promise<RunningTasksResult> {
    return this.projector.listRunningTasks();
  }

  async getOverview(activeOnly: boolean): Promise<ExecutionOverview> {
    return this.projector.getOverview(activeOnly);
  }
}

function idleStatus(sessionId: string): SessionTaskStatus {
  return { session_id: sessionId, has_running_task: false, has_active_system_command: false, task_info: null, observability: null, diagnostics: null };
}

function missingDiagnostics(scope: "session_id" | "task_id", id: string): ScopedExecutionDiagnostics {
  return { ...(scope === "session_id" ? { session_id: id } : { task_id: id }), scope, scope_id: id, found: false, diagnostics: null };
}

const emptyLivePort: ExecutionReadLivePort = {
  getSessionTaskStatus: (sessionId) => idleStatus(sessionId),
  getSessionExecutionDiagnostics: (sessionId) => missingDiagnostics("session_id", sessionId),
  getTaskStatus: (taskId) => ({ task_id: taskId, scope: "task_id", scope_id: taskId, found: false, has_running_task: false, task_info: null, observability: null }),
  getTaskExecutionDiagnostics: (taskId) => missingDiagnostics("task_id", taskId),
  listRunningTasks: () => ({ active_only: true, count: 0, items: [] }),
  getOverview: (activeOnly) => ({ active_only: activeOnly, count: 0, by_execution_kind: {}, by_status: {}, sessions: [], items: [] }),
};
