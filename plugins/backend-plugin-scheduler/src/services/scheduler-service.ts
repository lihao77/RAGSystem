import { randomUUID } from "node:crypto";

import type { TenantId, UserId } from "@ragsystem/backend-core/identity/types.js";
import type { SchedulerTaskStore, SchedulerTaskClaim } from "../contracts/task-store.js";
import type { SchedulerLeaderLease } from "../contracts/leader-lease.js";
import type { SchedulerDeliveryInput } from "../contracts/delivery.js";
import type { SchedulerTask, SchedulerTaskCreate, SchedulerTaskUpdate } from "../contracts/task.js";
import { computeNextRun } from "./cron-parser.js";

export class SchedulerServiceError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "SchedulerServiceError";
  }
}

/** 一次定时运行的执行结果（由 application-runtime 注入实现）。 */
export interface SchedulerRunOutcome {
  suspended: boolean;
  content: string;
}

export interface SchedulerRunInput {
  tenantId: TenantId;
  task: SchedulerTask;
}

export type SchedulerRunTask = (input: SchedulerRunInput) => Promise<SchedulerRunOutcome> | SchedulerRunOutcome;

/** 按通道投递；返回 false 表示通道不可用（由调用方降级记录）。 */
export type SchedulerDeliver = (input: SchedulerDeliveryInput) => Promise<boolean>;

export interface SchedulerServiceOptions {
  taskStore: SchedulerTaskStore;
  runTask: SchedulerRunTask;
  deliver?: SchedulerDeliver;
  leaderLease?: SchedulerLeaderLease;
  /** 调度循环间隔（毫秒），默认 60s；测试可调小。 */
  tickMs?: number;
}

interface TaskHistoryEntry {
  timestamp: number;
  success: boolean;
  result: string;
  error: string | null;
  elapsed: number;
}

const HISTORY_LIMIT = 50;

export class SchedulerService {
  private readonly history = new Map<string, Array<TaskHistoryEntry>>();
  private readonly leaseOwner = randomUUID();
  private startPromise: Promise<void> | null = null;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private leaderRetryTimer: NodeJS.Timeout | null = null;
  private schedulerRunning = false;
  private leader = false;

  constructor(private readonly options: SchedulerServiceOptions) {}

  async start(): Promise<void> {
    this.startPromise ??= this.initialize();
    await this.startPromise;
  }

  private async initialize(): Promise<void> {
    try {
      if (this.options.leaderLease && !(this.leader = await this.options.leaderLease.acquire())) {
        this.startLeaderRetry();
        return;
      }
      this.startScheduler();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private startLeaderRetry(): void {
    if (this.leaderRetryTimer || !this.options.leaderLease) return;
    this.leaderRetryTimer = setInterval(() => {
      void (async () => {
        if (this.leader || !this.options.leaderLease || !(await this.options.leaderLease.acquire())) return;
        this.leader = true;
        if (this.leaderRetryTimer) clearInterval(this.leaderRetryTimer);
        this.leaderRetryTimer = null;
        this.startScheduler();
      })().catch((error: unknown) => console.error("[scheduler] leader lease retry failed", error));
    }, 5_000);
    this.leaderRetryTimer.unref();
  }

  close(): void {
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    this.schedulerTimer = null;
    if (this.leaderRetryTimer) clearInterval(this.leaderRetryTimer);
    this.leaderRetryTimer = null;
    if (this.leader) {
      this.leader = false;
      void this.options.leaderLease?.release();
    }
    this.schedulerRunning = false;
    this.history.clear();
    this.startPromise = null;
  }

  private startScheduler(): void {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => {
      if (this.schedulerRunning) return;
      this.schedulerRunning = true;
      void this.runDueTasks(Date.now() / 1000).finally(() => {
        this.schedulerRunning = false;
      });
    }, this.options.tickMs ?? 60_000);
    this.schedulerTimer.unref();
  }

  private async runDueTasks(now: number): Promise<void> {
    const claims = await this.options.taskStore.claimDueTasks({
      now,
      leaseOwner: this.leaseOwner,
    });
    for (const claim of claims) {
      try {
        await this.triggerTask(claim.tenantId, claim.taskId, claim.claimToken);
        await this.options.taskStore.completeTaskClaim({
          tenantId: claim.tenantId,
          taskId: claim.taskId,
          claimToken: claim.claimToken,
        });
      } catch (error) {
        await this.options.taskStore.releaseTaskClaim({
          tenantId: claim.tenantId,
          taskId: claim.taskId,
          claimToken: claim.claimToken,
        });
        console.error(`[scheduler][${claim.tenantId}/${claim.taskId}] 自动调度失败`, error);
      }
    }
  }

  /**
   * 管理面列表。任务私有于 owner：传入 ownerId 时只返回该用户的任务；
   * 调度循环（runDueTasks）走 claim 面，始终扫全租户。
   */
  async listTasks(tenantId: TenantId, ownerId?: UserId): Promise<SchedulerTask[]> {
    return this.options.taskStore.listTasks(tenantId, ownerId);
  }

  async getTask(tenantId: TenantId, taskId: string, ownerId?: UserId): Promise<SchedulerTask | null> {
    const task = await this.options.taskStore.getTask(tenantId, taskId);
    if (!task) return null;
    if (ownerId && task.owner_user_id !== ownerId) {
      // 与不存在同样返回 null，不向其他成员泄露任务存在性
      return null;
    }
    return task;
  }

  async createTask(tenantId: TenantId, ownerId: string, input: SchedulerTaskCreate): Promise<SchedulerTask> {
    if (await this.options.taskStore.getTask(tenantId, input.task_id)) {
      throw new SchedulerServiceError(400, `任务已存在: ${input.task_id}`);
    }
    return this.options.taskStore.createTask(tenantId, ownerId, {
      ...input,
      next_run: input.enabled ? computeNextRun(input.cron) : null,
    });
  }

  async updateTask(tenantId: TenantId, taskId: string, patch: SchedulerTaskUpdate, ownerId?: UserId): Promise<SchedulerTask | null> {
    const current = await this.getTask(tenantId, taskId, ownerId);
    if (!current) return null;
    const cron = patch.cron ?? current.cron;
    const enabled = patch.enabled ?? current.enabled;
    return this.options.taskStore.updateTask(tenantId, taskId, {
      ...compactTaskPatch(patch),
      next_run: enabled ? computeNextRun(cron) : null,
    });
  }

  async deleteTask(tenantId: TenantId, taskId: string, ownerId?: UserId): Promise<boolean> {
    if (!(await this.getTask(tenantId, taskId, ownerId))) return false;
    const deleted = await this.options.taskStore.deleteTask(tenantId, taskId);
    if (deleted) this.history.delete(historyKey(tenantId, taskId));
    return deleted;
  }

  async triggerTask(tenantId: TenantId, taskId: string, claimToken?: string, ownerId?: UserId): Promise<{ status: "ok"; result: string | null }> {
    const task = await this.getTask(tenantId, taskId, ownerId);
    if (!task || !task.enabled) throw new SchedulerServiceError(404, `任务不存在或未启用: ${taskId}`);
    const startedAt = Date.now();
    const sessionId = resolveSessionId(task);
    try {
      const outcome = await this.options.runTask({ tenantId, task });
      const now = Date.now() / 1000;
      const summary = outcome.suspended ? "SUSPENDED" : outcome.content.slice(0, 200);
      await this.options.taskStore.updateTask(tenantId, taskId, {
        last_run: now,
        next_run: computeNextRun(task.cron),
        last_result: summary,
      }, claimToken ? { claimToken } : undefined);
      this.recordHistory(tenantId, taskId, { timestamp: now, success: true, result: summary, error: null, elapsed: (Date.now() - startedAt) / 1000 });
      await this.tryDeliver(task, sessionId, outcome.suspended, outcome.suspended ? "" : outcome.content);
      return { status: "ok", result: outcome.suspended ? null : outcome.content || null };
    } catch (error) {
      const now = Date.now() / 1000;
      const message = error instanceof Error ? error.message : String(error);
      await this.options.taskStore.updateTask(tenantId, taskId, {
        last_run: now,
        next_run: computeNextRun(task.cron),
        last_result: `ERROR: ${message}`,
      }, claimToken ? { claimToken } : undefined);
      this.recordHistory(tenantId, taskId, { timestamp: now, success: false, result: "", error: message, elapsed: (Date.now() - startedAt) / 1000 });
      throw new SchedulerServiceError(400, message);
    }
  }

  getTaskHistory(tenantId: TenantId, taskId: string, limit: number): TaskHistoryEntry[] {
    return (this.history.get(historyKey(tenantId, taskId)) ?? []).slice(0, Math.max(0, Math.floor(limit)));
  }

  private recordHistory(tenantId: TenantId, taskId: string, entry: TaskHistoryEntry): void {
    const key = historyKey(tenantId, taskId);
    const items = this.history.get(key) ?? [];
    items.unshift({ ...entry });
    this.history.set(key, items.slice(0, HISTORY_LIMIT));
  }

  /** 投递失败不影响任务执行结果：仅记日志（结果已落会话）。 */
  private async tryDeliver(task: SchedulerTask, sessionId: string, suspended: boolean, content: string): Promise<void> {
    if (!task.delivery || !this.options.deliver) return;
    try {
      const delivered = await this.options.deliver({
        tenantId: task.tenant_id,
        taskId: task.task_id,
        sessionId,
        channel: task.delivery.channel,
        target: task.delivery.target,
        botId: task.delivery.bot_id,
        suspended,
        content,
      });
      if (!delivered) console.warn(`[scheduler][${task.task_id}] 投递通道不可用: ${task.delivery.channel}`);
    } catch (error) {
      console.error(`[scheduler][${task.task_id}] 投递失败`, error);
    }
  }
}

export function resolveSessionId(task: Pick<SchedulerTask, "session_id" | "task_id">): string {
  return task.session_id?.trim() || `scheduler-${safeSessionPart(task.task_id)}`;
}

function compactTaskPatch(patch: SchedulerTaskUpdate): Partial<Omit<SchedulerTask, "tenant_id" | "task_id">> {
  const compact: Partial<Omit<SchedulerTask, "tenant_id" | "task_id">> = {};
  if (patch.cron !== undefined) compact.cron = patch.cron;
  if (patch.task !== undefined) compact.task = patch.task;
  if (patch.team !== undefined) compact.team = patch.team;
  if (patch.entry_agent !== undefined) compact.entry_agent = patch.entry_agent;
  if (patch.session_id !== undefined) compact.session_id = patch.session_id;
  if (patch.enabled !== undefined) compact.enabled = patch.enabled;
  if (patch.permission_mode !== undefined) compact.permission_mode = patch.permission_mode;
  if (patch.delivery !== undefined) compact.delivery = patch.delivery;
  return compact;
}

function historyKey(tenantId: TenantId, taskId: string): string {
  return `${tenantId}:${taskId}`;
}

function safeSessionPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "default";
}

export type { SchedulerTaskClaim };
