import { isRecord, asString } from "../../../utils/guards.js";
export { isRecord, asString };
import type { ExecutionObservability, ExecutionTaskStatus } from "../../../contracts/execution/execution.js";

export function buildObservability(status: ExecutionTaskStatus): ExecutionObservability {
  return {
    task_id: status.task_id,
    session_id: status.session_id,
    run_id: status.run_id,
    execution_kind: status.execution_kind,
    request_id: status.request_id,
  };
}

export function summarizeReadinessFailure(
  requirements: Array<{ category: string; satisfied: boolean; message: string }>,
): string {
  const failures = requirements.filter((item) => item.category !== "execution_runtime" && !item.satisfied);
  return failures.length ? failures.map((item) => item.message).join("; ") : "Runtime core configuration is not ready";
}

export function cloneStatus(status: ExecutionTaskStatus | null): ExecutionTaskStatus | null {
  return status ? { ...status } : null;
}

export function buildRunningExecutionStatus(input: {
  taskId: string;
  sessionId: string;
  runId: string;
  requestId: string;
  executionKind: string;
  task: string;
  startedAt: Date;
}): ExecutionTaskStatus {
  return {
    task_id: input.taskId,
    session_id: input.sessionId,
    run_id: input.runId,
    request_id: input.requestId,
    execution_kind: input.executionKind,
    task: input.task,
    status: "running",
    elapsed_seconds: null,
    started_at: input.startedAt.toISOString(),
    finished_at: null,
    thread_alive: true,
  };
}
