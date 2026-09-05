import { asString } from "../../utils/guards.js";

/**
 * 后台任务完成通知的统一投递形状：发布时渲染为 <task-notification> XML，以确定性
 * message id 落入会话 mailbox（input_type=system_notification、target=root 线程、
 * target_run_id=null）——idle 由会话 idle 检查消费，运行中由活动 run 的 refresh 认领
 * 注入，重启不丢。渲染在发布侧完成一次并随消息持久，两条消费路径读到的内容一致。
 */
export type BackgroundTaskNotificationPayload = Record<string, unknown>;

/** 通知消息的确定性 id：同一次任务完成重复发布时幂等（enqueue 同 id 同形状跳过）。 */
export function backgroundNotificationMessageId(taskId: string): string {
  return `bgnotify_${taskId}`;
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

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
