import type {
  ExecutionOverview,
  RunningTasksResult,
  ScopedExecutionDiagnostics,
  ScopedTaskStatus,
  SessionTaskStatus,
} from "../../../contracts/execution.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";

export interface ExecutionQueryApi {
  getSessionTaskStatus(sessionId: string): SessionTaskStatus;
  getSessionExecutionDiagnostics(sessionId: string): ScopedExecutionDiagnostics;
  getTaskStatus(taskId: string): ScopedTaskStatus;
  getTaskExecutionDiagnostics(taskId: string): ScopedExecutionDiagnostics;
  listRunningTasks(): RunningTasksResult;
  getOverview(activeOnly: boolean): ExecutionOverview;
}

/** 6 个只读状态查询，纯委托 statusTracker。 */
export function createExecutionQueryService(statusTracker: AgentExecutionStatusTracker): ExecutionQueryApi {
  return {
    getSessionTaskStatus: (sessionId) => statusTracker.getSessionTaskStatus(sessionId),
    getSessionExecutionDiagnostics: (sessionId) => statusTracker.getSessionExecutionDiagnostics(sessionId),
    getTaskStatus: (taskId) => statusTracker.getTaskStatus(taskId),
    getTaskExecutionDiagnostics: (taskId) => statusTracker.getTaskExecutionDiagnostics(taskId),
    listRunningTasks: () => statusTracker.listRunningTasks(),
    getOverview: (activeOnly) => statusTracker.getOverview(activeOnly),
  };
}
