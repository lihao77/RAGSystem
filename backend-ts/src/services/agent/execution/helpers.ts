import { isRecord, asString } from "../../../utils/guards.js";
export { isRecord, asString };
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { ExecutionObservability, ExecutionTaskStatus } from "../../../contracts/execution/execution.js";
import type { BackgroundTaskNotificationPayload } from "../../runtime/session-notification-queue.js";

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

export function renderBackgroundNotification(payload: BackgroundTaskNotificationPayload): string {
  const taskId = asString(payload.background_task_id) ?? asString(payload.task_id) ?? "unknown";
  const status = asString(payload.status) ?? "completed";
  const outputPath = asString(payload.output_path) ?? asString(payload.background_output_path);
  const returnCode = payload.return_code;
  const resultType = asString(payload.result_type);
  const summary = asString(payload.summary) ?? asString(payload.description) ?? backgroundTaskSummary(taskId, status);
  const parts = ["<task-notification>", `<task-id>${escapeXmlText(taskId)}</task-id>`];
  if (outputPath) {
    parts.push(`<output-file>${escapeXmlText(outputPath)}</output-file>`);
  }
  parts.push(`<status>${escapeXmlText(status)}</status>`);
  if (returnCode !== null && returnCode !== undefined) {
    parts.push(`<return-code>${escapeXmlText(String(returnCode))}</return-code>`);
  }
  if (resultType) {
    parts.push(`<result-type>${escapeXmlText(resultType)}</result-type>`);
  }
  if (summary) {
    parts.push(`<summary>${escapeXmlText(summary)}</summary>`);
  }
  parts.push("</task-notification>");
  return parts.join("\n");
}

function backgroundTaskSummary(taskId: string, status: string): string {
  if (status === "running") {
    return `后台任务 ${taskId} 仍在运行`;
  }
  if (status === "failed") {
    return `后台任务 ${taskId} 执行失败，输出已写入文件`;
  }
  if (status === "cancelled") {
    return `后台任务 ${taskId} 已取消，输出已写入文件`;
  }
  return `后台任务 ${taskId} 已完成，输出已写入文件`;
}

export function normalizeSessionEntryAgent(value: unknown): string | null {
  const normalized = asString(value);
  if (!normalized) {
    return null;
  }
  const lowered = normalized.toLowerCase();
  if (lowered === "default") {
    return null;
  }
  if (lowered === "orchestrator") {
    return "orchestrator_agent";
  }
  return normalized;
}

export function applySessionAgentOverrides(agent: AgentConfig, sessionMetadata: Record<string, unknown>): AgentConfig {
  const workspaceRoot = asString(sessionMetadata.workspace_root);
  if (!workspaceRoot) {
    return agent;
  }
  return {
    ...agent,
    custom_params: {
      ...agent.custom_params,
      workspace_root: workspaceRoot,
    },
  };
}



function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

