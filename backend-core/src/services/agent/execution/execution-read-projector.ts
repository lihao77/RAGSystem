import type { OutboxRow, RunInfo } from "../../../contracts/conversation-store/index.js";
import type {
  ExecutionOverview,
  ExecutionTaskStatus,
  RunningTasksResult,
  ScopedExecutionDiagnostics,
  ScopedTaskStatus,
  SessionTaskStatus,
} from "../../../contracts/execution/execution.js";
import type { SessionInfo } from "../../../contracts/session/session.js";
import { buildObservability } from "./helpers.js";

export interface ExecutionReadLivePort {
  getSessionTaskStatus(sessionId: string): SessionTaskStatus;
  getSessionExecutionDiagnostics(sessionId: string): ScopedExecutionDiagnostics;
  getTaskStatus(taskId: string): ScopedTaskStatus;
  getTaskExecutionDiagnostics(taskId: string): ScopedExecutionDiagnostics;
  listRunningTasks(): RunningTasksResult;
  getOverview(activeOnly: boolean): ExecutionOverview;
}

export interface ExecutionReadDurablePort {
  getSession(sessionId: string): Promise<SessionInfo | null>;
  listRuns(sessionId: string, limit: number): Promise<RunInfo[]>;
  listOutboxForReplay(input: { sessionId: string; runIds?: readonly string[]; afterSeq?: number | null; limit?: number }): Promise<OutboxRow[]>;
  listRunsForOverview(activeOnly: boolean): Promise<RunInfo[]>;
  getRunByTaskId?(taskId: string): Promise<RunInfo | null>;
  getPersistedOverview?(activeOnly: boolean): Promise<ExecutionOverview>;
}

/** One status/read projection used by both Local and SaaS adapters. */
export class ExecutionReadProjector {
  constructor(
    private readonly live: ExecutionReadLivePort,
    private readonly durable: ExecutionReadDurablePort,
  ) {}

  getSession(sessionId: string) { return this.durable.getSession(sessionId); }
  async listRuns(sessionId: string, limit = 500) {
    return await this.durable.getSession(sessionId) ? this.durable.listRuns(sessionId, limit) : [];
  }
  async listOutboxForReplay(input: Parameters<ExecutionReadDurablePort["listOutboxForReplay"]>[0]) {
    return await this.durable.getSession(input.sessionId) ? this.durable.listOutboxForReplay(input) : [];
  }

  async getSessionTaskStatus(sessionId: string): Promise<SessionTaskStatus> {
    if (!await this.durable.getSession(sessionId)) return idleStatus(sessionId);
    const live = this.live.getSessionTaskStatus(sessionId);
    const durable = latestRootRun(await this.durable.listRuns(sessionId, 500));
    if (live.task_info?.status === "running") return live;
    if (durable && (!live.task_info || isNewer(durable.updated_at, live.task_info.finished_at ?? live.task_info.started_at))) {
      return sessionStatus(sessionId, toTaskStatus(durable));
    }
    return live.task_info ? live : durable ? sessionStatus(sessionId, toTaskStatus(durable)) : idleStatus(sessionId);
  }

  async getSessionExecutionDiagnostics(sessionId: string): Promise<ScopedExecutionDiagnostics> {
    const status = await this.getSessionTaskStatus(sessionId);
    return {
      session_id: sessionId,
      scope: "session_id",
      scope_id: sessionId,
      found: Boolean(status.task_info),
      diagnostics: status.task_info ? diagnostics(status.task_info) : null,
    };
  }

  async getTaskStatus(taskId: string): Promise<ScopedTaskStatus> {
    const live = this.live.getTaskStatus(taskId);
    if (live.found) return live;
    const run = await this.durable.getRunByTaskId?.(taskId);
    const task = run ? toTaskStatus(run) : null;
    return {
      task_id: taskId,
      scope: "task_id",
      scope_id: taskId,
      found: task !== null,
      has_running_task: task?.status === "running",
      task_info: task,
      observability: task ? buildObservability(task) : null,
    };
  }

  async getTaskExecutionDiagnostics(taskId: string): Promise<ScopedExecutionDiagnostics> {
    const status = await this.getTaskStatus(taskId);
    return {
      task_id: taskId,
      scope: "task_id",
      scope_id: taskId,
      found: status.found,
      diagnostics: status.task_info ? diagnostics(status.task_info) : null,
    };
  }

  async listRunningTasks(): Promise<RunningTasksResult> {
    const live = this.live.listRunningTasks().items;
    const durable = (await this.durable.listRunsForOverview(true)).map(toTaskStatus);
    const items = mergeTasks(live, durable).filter((item) => item.status === "running");
    return { active_only: true, count: items.length, items };
  }

  async getOverview(activeOnly: boolean): Promise<ExecutionOverview> {
    const liveOverview = this.live.getOverview(activeOnly);
    const persistedOverview = await this.durable.getPersistedOverview?.(activeOnly);
    if (liveOverview.count === 0 && persistedOverview) return persistedOverview;
    const live = liveOverview.items;
    const durable = (await this.durable.listRunsForOverview(activeOnly)).map(toTaskStatus);
    const items = mergeTasks(live, durable);
    return projectOverview(activeOnly, items);
  }
}

function latestRootRun(runs: RunInfo[]): RunInfo | null {
  const roots = runs.filter((run) => !run.parent_run_id && !run.child_agent_id);
  return (roots.length ? roots : runs).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0] ?? null;
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

function mergeTasks(...groups: ExecutionTaskStatus[][]): ExecutionTaskStatus[] {
  const byId = new Map<string, ExecutionTaskStatus>();
  for (const task of groups.flat()) {
    const current = byId.get(task.task_id);
    if (!current || String(task.started_at ?? "") >= String(current.started_at ?? "")) byId.set(task.task_id, task);
  }
  return [...byId.values()].sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")));
}

function projectOverview(activeOnly: boolean, items: ExecutionTaskStatus[]): ExecutionOverview {
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

function sessionStatus(sessionId: string, task: ExecutionTaskStatus): SessionTaskStatus {
  return { session_id: sessionId, has_running_task: task.status === "running", has_active_system_command: false, task_info: task, observability: buildObservability(task), diagnostics: diagnostics(task) };
}
function idleStatus(sessionId: string): SessionTaskStatus { return { session_id: sessionId, has_running_task: false, has_active_system_command: false, task_info: null, observability: null, diagnostics: null }; }
function diagnostics(task: ExecutionTaskStatus) { return { task, runner: null, observability: buildObservability(task), handle_registered: false, is_running: task.status === "running" }; }
function isNewer(left: string | null | undefined, right: string | null | undefined): boolean { return String(left ?? "") >= String(right ?? ""); }
