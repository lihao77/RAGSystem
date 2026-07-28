import type { OutboxRow, RunInfo } from "../conversation-store/index.js";
import type { ExecutionOverview, RunningTasksResult, ScopedExecutionDiagnostics, ScopedTaskStatus, SessionTaskStatus } from "./execution.js";
import type { SessionInfo } from "../session/session.js";

/** Deployment-neutral read boundary for execution status HTTP endpoints. */
export interface ExecutionReadApplication {
  getSession(sessionId: string): Promise<SessionInfo | null>;
  listRuns(sessionId: string, limit?: number): Promise<RunInfo[]>;
  listOutboxForReplay(input: { sessionId: string; runIds?: readonly string[]; afterSeq?: number | null; limit?: number }): Promise<OutboxRow[]>;
  getSessionTaskStatus(sessionId: string): Promise<SessionTaskStatus>;
  getSessionExecutionDiagnostics(sessionId: string): Promise<ScopedExecutionDiagnostics>;
  getTaskStatus(taskId: string): Promise<ScopedTaskStatus>;
  getTaskExecutionDiagnostics(taskId: string): Promise<ScopedExecutionDiagnostics>;
  listRunningTasks(): Promise<RunningTasksResult>;
  getOverview(activeOnly: boolean): Promise<ExecutionOverview>;
}
