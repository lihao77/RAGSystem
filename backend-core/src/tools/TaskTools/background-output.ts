import { asString } from "../../utils/guards.js";
export { asString };
export function buildBackgroundOutputContent(snapshot: Record<string, unknown>, rawOutput: string | null): Record<string, unknown> {
  const resultType = asString(snapshot.result_type);
  let parsedOutput: unknown = null;
  if (rawOutput) {
    if (resultType !== "bash_output") {
      try {
        parsedOutput = JSON.parse(rawOutput) as unknown;
      } catch {
        parsedOutput = rawOutput;
      }
    } else {
      parsedOutput = rawOutput;
    }
  }
  const status = asString(snapshot.status);
  return {
    task_id: snapshot.task_id,
    description: snapshot.description ?? "",
    status,
    completed: isBackgroundTerminalStatus(status ?? ""),
    return_code: snapshot.return_code ?? null,
    error: snapshot.error ?? null,
    result_type: resultType,
    started_at: snapshot.started_at ?? null,
    completed_at: snapshot.completed_at ?? null,
    output_path: snapshot.output_path ?? null,
    kind: snapshot.kind ?? null,
    cancel_supported: snapshot.cancel_supported ?? false,
    output: parsedOutput,
  };
}

export function buildBackgroundNotificationPayload(snapshot: Record<string, unknown>, timeout: boolean): Record<string, unknown> {
  const taskId = asString(snapshot.background_task_id) ?? asString(snapshot.task_id) ?? "unknown";
  const status = asString(snapshot.status) ?? (timeout ? "running" : "completed");
  return {
    task_id: taskId,
    background_task_id: taskId,
    status,
    return_code: snapshot.return_code ?? null,
    result_type: snapshot.result_type ?? null,
    output_path: snapshot.output_path ?? snapshot.background_output_path ?? null,
    completed_at: snapshot.completed_at ?? null,
    success: !timeout && status === "completed",
    summary: backgroundTaskSummary(taskId, status, timeout),
  };
}

export function isBackgroundTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}



function backgroundTaskSummary(taskId: string, status: string, timeout: boolean): string {
  if (status === "missing") {
    return `后台任务 ${taskId} 不存在`;
  }
  if (timeout || status === "running") {
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
