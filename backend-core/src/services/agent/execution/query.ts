import type {
  ExecutionOverview,
  RunningTasksResult,
  ScopedExecutionDiagnostics,
  ScopedTaskStatus,
} from "../../../contracts/execution/execution.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";

export interface ExecutionQueryApi {
  getSessionExecutionDiagnostics(sessionId: string): ScopedExecutionDiagnostics;
  getTaskStatus(taskId: string): ScopedTaskStatus;
  getTaskExecutionDiagnostics(taskId: string): ScopedExecutionDiagnostics;
  listRunningTasks(): RunningTasksResult;
  getOverview(activeOnly: boolean): ExecutionOverview;
}

/** 5 个监控/诊断查询，纯委托 statusTracker；Session 生命周期不从这里投影。 */
export function createExecutionQueryService(statusTracker: AgentExecutionStatusTracker): ExecutionQueryApi {
  return {
    getSessionExecutionDiagnostics: (sessionId) => statusTracker.getSessionExecutionDiagnostics(sessionId),
    getTaskStatus: (taskId) => statusTracker.getTaskStatus(taskId),
    getTaskExecutionDiagnostics: (taskId) => statusTracker.getTaskExecutionDiagnostics(taskId),
    listRunningTasks: () => statusTracker.listRunningTasks(),
    getOverview: (activeOnly) => statusTracker.getOverview(activeOnly),
  };
}
