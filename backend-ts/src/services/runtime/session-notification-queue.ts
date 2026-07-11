export type BackgroundTaskNotificationPayload = Record<string, unknown>;

/**
 * Session 级后台任务完成通知的暂存队列（单一数据来源）。
 *
 * 后台任务完成 → add 入队（内存暂存）→ 被某 run drain → 由消费者落库为 user 消息
 * （source:background_notification）永久留痕。queue 本身只做待投递暂存，不落库——后台任务
 * 本身是内存态，后端重启同丢，通知单独落库无意义。
 *
 * 自动触发 run 与活动 run 的消费者共享同一队列并互斥消费：drain 即清空，通知只投递一次。
 *
 * 纯数据层，不含触发/起 run 逻辑——触发编排（scheduleAutoTrigger）在 BackgroundTaskService，
 * 起 run 在 launchers.triggerBgNotificationRun。
 */
export class SessionNotificationQueue {
  private readonly pending = new Map<string, BackgroundTaskNotificationPayload[]>();
  private readonly consumed = new Map<string, Set<string>>();

  /**
   * 入队。若 taskId 已在 consumed 集合（曾被 markConsumed），
   * 视为已消费：清除标记、不入队；否则入 pending。
   */
  add(sessionId: string, payload: BackgroundTaskNotificationPayload): void {
    const taskId = readTaskId(payload);
    const consumed = this.consumed.get(sessionId);
    if (taskId && consumed?.has(taskId)) {
      consumed.delete(taskId);
      if (consumed.size === 0) {
        this.consumed.delete(sessionId);
      }
      return;
    }
    const pending = this.pending.get(sessionId) ?? [];
    pending.push(payload);
    this.pending.set(sessionId, pending);
  }

  /**
   * 取出并清空 pending。excludeTaskIds 对应的任务保留在队列，供调用方避免重复消费。
   */
  drain(
    sessionId: string,
    excludeTaskIds: ReadonlySet<string> = EMPTY_SET,
  ): BackgroundTaskNotificationPayload[] {
    const pending = this.pending.get(sessionId);
    if (!pending?.length) {
      return [];
    }
    if (excludeTaskIds.size === 0) {
      this.pending.delete(sessionId);
      return pending;
    }
    const drained: BackgroundTaskNotificationPayload[] = [];
    const retained: BackgroundTaskNotificationPayload[] = [];
    for (const payload of pending) {
      const taskId = readTaskId(payload);
      if (taskId && excludeTaskIds.has(taskId)) {
        retained.push(payload);
      } else {
        drained.push(payload);
      }
    }
    if (retained.length) {
      this.pending.set(sessionId, retained);
    } else {
      this.pending.delete(sessionId);
    }
    return drained;
  }

  /** 非消费式判空（队列是否有待投递通知）。 */
  peek(sessionId: string): boolean {
    const pending = this.pending.get(sessionId);
    return !!pending?.length;
  }

  /** 标记 taskId 已消费并从 pending 移除，防重复投递。 */
  markConsumed(sessionId: string, taskId: string): void {
    const consumed = this.consumed.get(sessionId) ?? new Set<string>();
    consumed.add(taskId);
    this.consumed.set(sessionId, consumed);
    const pending = this.pending.get(sessionId);
    if (!pending?.length) {
      return;
    }
    const retained = pending.filter((payload) => readTaskId(payload) !== taskId);
    if (retained.length) {
      this.pending.set(sessionId, retained);
    } else {
      this.pending.delete(sessionId);
    }
  }
}

const EMPTY_SET: ReadonlySet<string> = new Set();

function readTaskId(payload: BackgroundTaskNotificationPayload): string | null {
  const byBg = payload.background_task_id;
  if (typeof byBg === "string" && byBg.trim()) {
    return byBg.trim();
  }
  const byTask = payload.task_id;
  if (typeof byTask === "string" && byTask.trim()) {
    return byTask.trim();
  }
  return null;
}
