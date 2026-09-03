import type {
  ExecutionDiagnostics,
  ExecutionOverview,
  ExecutionTaskStatus,
  RunningTasksResult,
  ScopedExecutionDiagnostics,
  ScopedTaskStatus,
} from "../../../contracts/execution/execution.js";
import { buildObservability, cloneStatus } from "./helpers.js";

export interface ExecutionHandle {
  abortController: AbortController;
  status: ExecutionTaskStatus;
  promise: Promise<unknown>;
}

/**
 * run 控制面取像器：把该 run 当前在飞轮的累计流式文本作为一帧带内快照
 * 发进它自己的事件流（帧的流内位置即覆盖点）。由 runtime-adapter 在 run 存活期注册。
 */
export type StreamSnapshotEmitter = () => Promise<void>;

/** runtime-adapter 侧可见的注册面；statusTracker 同时暴露触发面给重连处理器。 */
export interface StreamSnapshotRegistry {
  registerStreamSnapshot(runId: string, emit: StreamSnapshotEmitter): void;
  unregisterStreamSnapshot(runId: string, emit: StreamSnapshotEmitter): void;
}

export class AgentExecutionStatusTracker {
  private readonly handlesByTask = new Map<string, ExecutionHandle>();
  private readonly taskBySession = new Map<string, string>();
  private readonly controllersByRun = new Map<string, AbortController>();
  // 维护类长操作（当前仅 /compact 摘要）按会话注册的中止通道；与 run 的 controllersByRun
  // 同语义：进程内句柄，stopSession 直接触发 abort。跨实例场景与前台 run 一致不覆盖
  // （租约 TTL 过期自愈），这里只服务"本实例正在执行的维护可被用户停止"。
  private readonly maintenanceControllers = new Map<string, AbortController>();
  private readonly streamSnapshotEmitters = new Map<string, StreamSnapshotEmitter>();
  private readonly statusHistory = new Map<string, ExecutionTaskStatus>();

  registerMaintenanceAbort(sessionId: string, controller: AbortController): void {
    if (!sessionId) return;
    this.maintenanceControllers.set(sessionId, controller);
  }

  unregisterMaintenanceAbort(sessionId: string, controller?: AbortController): void {
    const current = this.maintenanceControllers.get(sessionId);
    if (current && (!controller || current === controller)) this.maintenanceControllers.delete(sessionId);
  }

  /** 用户视角统一语义：进行中的压缩无论来源（run 内自动 / 手动 /compact）都可停止。 */
  cancelMaintenanceAbort(sessionId: string, reason = "user_stop"): boolean {
    const controller = this.maintenanceControllers.get(sessionId);
    if (!controller) return false;
    if (!controller.signal.aborted) controller.abort(new Error(reason));
    return true;
  }

  registerStreamSnapshot(runId: string, emit: StreamSnapshotEmitter): void {
    if (!runId) return;
    this.streamSnapshotEmitters.set(runId, emit);
  }

  /** 身份校验注销：晚到的旧 emitter 不得清掉同 runId 的新注册（resume 复用 runId）。 */
  unregisterStreamSnapshot(runId: string, emit: StreamSnapshotEmitter): void {
    if (this.streamSnapshotEmitters.get(runId) === emit) this.streamSnapshotEmitters.delete(runId);
  }

  /**
   * 重连取像触发：run 不在本进程活跃（或已结束）时静默 no-op。
   * emitter 内部异常（如 run 的 journal 已中毒）在此吞掉——快照是 best-effort 增强，
   * 失败只降级为检查点粒度恢复，绝不得掐断重连握手。
   */
  async emitStreamSnapshot(runId: string): Promise<void> {
    try {
      await this.streamSnapshotEmitters.get(runId)?.();
    } catch {
      // best-effort by contract
    }
  }

  registerRun(runId: string, abortController: AbortController): void {
    if (!runId) return;
    this.controllersByRun.set(runId, abortController);
  }

  unregisterRun(runId: string, abortController?: AbortController): void {
    const current = this.controllersByRun.get(runId);
    if (current && (!abortController || current === abortController)) this.controllersByRun.delete(runId);
  }

  cancelRun(runId: string, reason = "cancelled"): "aborted" | "already_aborted" | "no_active_run" {
    const controller = this.controllersByRun.get(runId);
    if (!controller) return "no_active_run";
    if (controller.signal.aborted) return "already_aborted";
    controller.abort(new Error(reason));
    return "aborted";
  }

  register(taskId: string, sessionId: string, handle: ExecutionHandle): void {
    this.handlesByTask.set(taskId, handle);
    this.taskBySession.set(sessionId, taskId);
    this.statusHistory.set(taskId, handle.status);
  }

  unregister(taskId: string, sessionId: string): void {
    if (this.taskBySession.get(sessionId) === taskId) {
      this.taskBySession.delete(sessionId);
    }
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
