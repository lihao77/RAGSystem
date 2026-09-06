import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { BackgroundTaskService } from "../../runtime/background-task-service.js";

export interface SessionBusyCheckDeps {
  statusTracker: AgentExecutionStatusTracker;
  runtimeStorage: RuntimeStorage;
  backgroundTasks: BackgroundTaskService | null;
}

export interface SessionBusyResult {
  /** "run" = 本进程或持久层有进行中 root run；"background_tasks" = 有运行中后台任务。 */
  reason: "run" | "background_tasks";
  runId: string | null;
  taskId: string | null;
}

/**
 * 会话忙检查的唯一口径（消费组件三处共用）：本进程状态 → 持久活动 root run →
 * 运行中后台任务，按序短路。suspend 视为忙（自动续跑须等恢复收尾）；用户发送
 * 通道的拒绝策略另有语义（仅 running、需错误文案），不经此助手。
 */
export async function checkSessionBusy(
  deps: SessionBusyCheckDeps,
  sessionId: string,
): Promise<SessionBusyResult | null> {
  const status = deps.statusTracker.getStatusBySession(sessionId);
  if (status?.status === "running" || status?.status === "suspended") {
    return { reason: "run", runId: status.run_id ?? null, taskId: status.task_id ?? null };
  }
  const durableRunId = (await deps.runtimeStorage.operations.getActiveRootRun?.(sessionId))?.runId ?? null;
  if (durableRunId) {
    return { reason: "run", runId: durableRunId, taskId: null };
  }
  // 后台任务归属按发起者收窄（§10.4 第五轮）：主智能体闸门只等它自己发起的任务；
  // 历史行无 initiator 字段视为 root 发起，行为与旧口径一致。
  if (await deps.backgroundTasks?.hasRunningTasksDurable(sessionId, "root")) {
    return { reason: "background_tasks", runId: null, taskId: null };
  }
  return null;
}
