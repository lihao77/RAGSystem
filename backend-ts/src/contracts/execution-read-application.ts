import type { ExecutionOverview, RunningTasksResult, ScopedExecutionDiagnostics, ScopedTaskStatus, SessionTaskStatus } from "./execution.js";

/** Deployment-neutral read boundary for execution status HTTP endpoints. */
export interface ExecutionReadApplication {
  getSessionTaskStatus(sessionId: string): Promise<SessionTaskStatus>;
  getSessionExecutionDiagnostics(sessionId: string): Promise<ScopedExecutionDiagnostics>;
  getTaskStatus(taskId: string): Promise<ScopedTaskStatus>;
  getTaskExecutionDiagnostics(taskId: string): Promise<ScopedExecutionDiagnostics>;
  listRunningTasks(): Promise<RunningTasksResult>;
  getOverview(activeOnly: boolean): Promise<ExecutionOverview>;
}
