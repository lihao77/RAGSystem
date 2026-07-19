import { isRecord, normalizeString, asString } from "../../utils/guards.js";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AsyncBackgroundTaskRepository, DurableBackgroundTaskRecord } from "../../contracts/storage/background-task-repository.js";

import type { ClientEventPublisher } from "./event-outbox/client-event-publisher.js";
import { SessionNotificationQueue } from "./session-notification-queue.js";
import type { BackgroundTaskNotificationPayload } from "./session-notification-queue.js";
import { terminateProcessTree } from "./process-tree.js";

type BackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTask {
  task_id: string;
  description: string;
  output_path: string;
  started_at: number;
  status: BackgroundTaskStatus;
  return_code: number | null;
  error: string | null;
  expires_at: number | null;
  run_id: string | null;
  owner_task_id: string | null;
  session_id: string | null;
  completed_at: number | null;
  result_type: string | null;
  kind: string;
  cancel_supported: boolean;
}

export interface SpawnBashInput {
  command: string;
  bashExecutable: string | null;
  cwd: string;
  outputDir: string;
  description?: string | null;
  env?: Record<string, string | undefined> | undefined;
  maxRuntimeSeconds?: number | null | undefined;
  clientEvents?: ClientEventPublisher | null | undefined;
  sessionId?: string | null | undefined;
  runId?: string | null | undefined;
  ownerTaskId?: string | null | undefined;
}

export interface RunCallableInput {
  outputDir: string;
  description?: string | null | undefined;
  run: () => unknown | Promise<unknown>;
  clientEvents?: ClientEventPublisher | null | undefined;
  sessionId?: string | null | undefined;
  runId?: string | null | undefined;
  ownerTaskId?: string | null | undefined;
  kind?: string | null | undefined;
  resultType?: string | null | undefined;
}

export class BackgroundTaskService {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly ownedTaskIds = new Set<string>();
  private readonly retentionSeconds: number;
  private readonly notificationQueue: SessionNotificationQueue;
  private readonly triggeringSessions = new Set<string>();
  private readonly pendingTriggers = new Set<ReturnType<typeof setTimeout>>();
  private readonly repository: AsyncBackgroundTaskRepository | null;
  private readonly tenantId: string | null;
  private readonly instanceId = randomUUID();
  private readonly leaseSeconds: number;
  private readonly heartbeatTimer: ReturnType<typeof setInterval> | null;
  private persistence = Promise.resolve();
  private onTaskCompleted: ((sessionId: string) => void) | null = null;

  constructor(options: {
    retentionSeconds?: number | undefined;
    notificationQueue?: SessionNotificationQueue | undefined;
    repository?: AsyncBackgroundTaskRepository | null | undefined;
    tenantId?: string | null | undefined;
    leaseSeconds?: number | undefined;
  } = {}) {
    this.retentionSeconds = positiveInt(options.retentionSeconds, 2 * 60 * 60);
    this.notificationQueue = options.notificationQueue ?? new SessionNotificationQueue();
    this.repository = options.repository ?? null;
    this.tenantId = normalizeString(options.tenantId);
    this.leaseSeconds = positiveInt(options.leaseSeconds, 30);
    if (this.repository && !this.tenantId) {
      throw new Error("durable BackgroundTaskService requires tenantId");
    }
    this.heartbeatTimer = this.repository
      ? setInterval(() => this.persistRunningTasks(), Math.max(1_000, Math.floor(this.leaseSeconds * 500)))
      : null;
    this.heartbeatTimer?.unref();
  }

  async initialize(): Promise<void> {
    if (!this.repository || !this.tenantId) return;
    const now = nowSeconds();
    await this.repository.failExpiredRunning(this.tenantId, now, "background task owner lease expired after runtime restart");
    await this.repository.deleteExpired(this.tenantId, now);
    for (const record of await this.repository.listActive(this.tenantId, now)) {
      this.tasks.set(record.task_id, fromDurableRecord(record));
    }
  }

  async waitForPersistence(): Promise<void> {
    await this.persistence;
  }

  /** 注入"后台完成 → 自动触发 system run"回调（runtime-container lazy 绑定 triggerBgNotificationRun）。 */
  setOnTaskCompleted(handler: ((sessionId: string) => void) | null): void {
    this.onTaskCompleted = handler;
  }

  /** 供 run-engine 询问队列是否有待投递通知（run 结束时判定是否再触发一轮）。 */
  hasPendingNotifications(sessionId: string): boolean {
    return this.notificationQueue.peek(sessionId);
  }

  /**
   * 编排自动触发：triggeringSessions 去重 + setTimeout 1s 后调 onTaskCompleted（给当前 run 收尾
   * 留窗口，对齐 Python notification_trigger.time.sleep(1.0)）。由后台完成（publishCompleted）与
   * run 结束（run-engine promise.finally）两处调用。
   */
  scheduleAutoTrigger(sessionId: string): void {
    if (!sessionId || this.triggeringSessions.has(sessionId)) {
      return;
    }
    this.triggeringSessions.add(sessionId);
    const timer = setTimeout(() => {
      this.pendingTriggers.delete(timer);
      this.triggeringSessions.delete(sessionId);
      this.onTaskCompleted?.(sessionId);
    }, 1000);
    this.pendingTriggers.add(timer);
  }

  /** 取消所有 pending 自动触发定时器（容器关闭时调用，避免回调写已 close 的 store）。 */
  dispose(): void {
    for (const timer of this.pendingTriggers) {
      clearTimeout(timer);
    }
    this.pendingTriggers.clear();
    this.triggeringSessions.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  spawnBash(input: SpawnBashInput): BackgroundTask {
    const taskId = randomUUID();
    fs.mkdirSync(input.outputDir, { recursive: true });
    const outputPath = path.join(input.outputDir, `bg_${taskId.slice(0, 8)}.log`);
    const task: BackgroundTask = {
      task_id: taskId,
      description: normalizeString(input.description) ?? input.command.slice(0, 80),
      output_path: outputPath,
      started_at: nowSeconds(),
      status: "running",
      return_code: null,
      error: null,
      expires_at: nowSeconds() + this.retentionSeconds,
      run_id: normalizeString(input.runId),
      owner_task_id: normalizeString(input.ownerTaskId),
      session_id: normalizeString(input.sessionId),
      completed_at: null,
      result_type: null,
      kind: "bash",
      cancel_supported: true,
    };
    this.tasks.set(taskId, task);
    this.ownedTaskIds.add(taskId);
    this.persistTask(task);

    const output = fs.createWriteStream(outputPath, { encoding: "utf8" });
    const env = {
      ...process.env,
      LC_ALL: process.platform === "win32" ? process.env.LC_ALL : "C.UTF-8",
      ...(input.env ?? {}),
    };
    try {
      const proc = input.bashExecutable
        ? spawn(input.bashExecutable, ["-c", input.command], {
            cwd: input.cwd,
            env,
            windowsHide: true,
            detached: process.platform !== "win32",
          })
        : spawn(input.command, [], {
            cwd: input.cwd,
            env,
            shell: true,
            windowsHide: true,
            detached: process.platform !== "win32",
          });

      this.processes.set(taskId, proc);
      proc.stdout?.pipe(output, { end: false });
      proc.stderr?.pipe(output, { end: false });

      let runtimeTimer: NodeJS.Timeout | null = null;
      const maxRuntimeSeconds = positiveIntOrNull(input.maxRuntimeSeconds);
      if (maxRuntimeSeconds !== null) {
        runtimeTimer = setTimeout(() => {
          terminateProcessTree(proc.pid, false);
          setTimeout(() => terminateProcessTree(proc.pid, true), 500);
        }, maxRuntimeSeconds * 1000);
      }

      proc.on("error", (error) => {
        const current = this.tasks.get(taskId);
        if (current && !isDone(current.status)) {
          current.status = "failed";
          current.error = error.message;
          current.completed_at = nowSeconds();
          current.result_type = "bash_output";
          this.persistTask(current);
        }
      });
      proc.on("close", (code) => {
        if (runtimeTimer) {
          clearTimeout(runtimeTimer);
        }
        this.processes.delete(taskId);
        const current = this.tasks.get(taskId);
        if (current && !isDone(current.status)) {
          current.return_code = code ?? 0;
          current.status = current.return_code === 0 ? "completed" : "failed";
          current.result_type = "bash_output";
          current.completed_at = nowSeconds();
          this.persistTask(current);
        }
        output.end(() => {
          const snapshot = this.getTask(taskId);
          if (snapshot) {
            this.publishCompleted(snapshot);
          }
        });
      });
    } catch (error) {
      output.end();
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.result_type = "bash_output";
      task.completed_at = nowSeconds();
      this.persistTask(task);
    }

    return { ...task };
  }

  runCallable(input: RunCallableInput): BackgroundTask {
    const taskId = randomUUID();
    fs.mkdirSync(input.outputDir, { recursive: true });
    const outputPath = path.join(input.outputDir, `bg_${taskId.slice(0, 8)}.json`);
    const task: BackgroundTask = {
      task_id: taskId,
      description: normalizeString(input.description) ?? "background callable",
      output_path: outputPath,
      started_at: nowSeconds(),
      status: "running",
      return_code: null,
      error: null,
      expires_at: nowSeconds() + this.retentionSeconds,
      run_id: normalizeString(input.runId),
      owner_task_id: normalizeString(input.ownerTaskId),
      session_id: normalizeString(input.sessionId),
      completed_at: null,
      result_type: normalizeString(input.resultType) ?? "tool_execution_result",
      kind: normalizeString(input.kind) ?? "callable",
      cancel_supported: false,
    };
    this.tasks.set(taskId, task);
    this.ownedTaskIds.add(taskId);
    this.persistTask(task);

    void this.executeCallableTask(taskId, outputPath, input.run);
    return { ...task };
  }

  getTask(taskId: string): BackgroundTask | null {
    this.cleanupExpiredTasks();
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  getTaskSnapshot(taskId: string): Record<string, unknown> | null {
    const task = this.getTask(taskId);
    if (!task) {
      return null;
    }
    return {
      task_id: task.task_id,
      description: task.description,
      status: task.status,
      return_code: task.return_code,
      error: task.error,
      started_at: task.started_at,
      completed_at: task.completed_at,
      result_type: task.result_type,
      output_path: task.output_path,
      run_id: task.run_id,
      owner_task_id: task.owner_task_id,
      session_id: task.session_id,
      kind: task.kind,
      cancel_supported: task.cancel_supported,
    };
  }

  readOutput(taskId: string, maxChars?: number | null | undefined): string | null {
    const task = this.tasks.get(taskId);
    if (!task || !fs.existsSync(task.output_path)) {
      return null;
    }
    const output = fs.readFileSync(task.output_path, "utf8");
    const limit = positiveIntOrNull(maxChars);
    if (limit === null || output.length <= limit) {
      return output;
    }
    return output.slice(0, limit);
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    const proc = this.processes.get(taskId);
    if (!task || !this.ownedTaskIds.has(taskId) || isDone(task.status) || !task.cancel_supported) {
      return false;
    }
    if (proc) {
      terminateProcessTree(proc.pid, false);
      setTimeout(() => terminateProcessTree(proc.pid, true), 500);
    }
    task.status = "cancelled";
    task.completed_at = nowSeconds();
    this.persistTask(task);
    return true;
  }

  private cleanupExpiredTasks(): void {
    const now = nowSeconds();
    for (const [taskId, task] of this.tasks.entries()) {
      if (isDone(task.status) && task.expires_at !== null && task.expires_at <= now) {
        this.tasks.delete(taskId);
        this.processes.delete(taskId);
      }
    }
  }

  private async executeCallableTask(
    taskId: string,
    outputPath: string,
    run: () => unknown | Promise<unknown>,
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || isDone(task.status)) {
      return;
    }
    try {
      const result = await run();
      const success = !isRecord(result) || result.success !== false;
      fs.writeFileSync(
        outputPath,
        `${JSON.stringify({
          success,
          result_type: task.result_type,
          result,
        }, null, 2)}\n`,
        "utf8",
      );
      task.return_code = success ? 0 : 1;
      task.status = success ? "completed" : "failed";
      task.completed_at = nowSeconds();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fs.writeFileSync(
        outputPath,
        `${JSON.stringify({
          success: false,
          result_type: task.result_type,
          error: message,
        }, null, 2)}\n`,
        "utf8",
      );
      task.return_code = 1;
      task.status = "failed";
      task.error = message;
      task.completed_at = nowSeconds();
    }
    this.persistTask(task);
    const snapshot = this.getTask(taskId);
    if (snapshot) {
      this.publishCompleted(snapshot);
    }
  }

  private publishCompleted(task: BackgroundTask): void {
    const payload: BackgroundTaskNotificationPayload = {
      task_id: task.task_id,
      background_task_id: task.task_id,
      status: task.status,
      return_code: task.return_code,
      success: task.status === "completed",
      run_id: task.run_id,
      owner_task_id: task.owner_task_id,
      completed_at: task.completed_at,
      output_path: task.output_path,
      result_type: task.result_type,
      session_id: task.session_id,
    };
    if (task.session_id) {
      // 入暂存队列（consumed 去重由 queue.add 承接）+ 编排自动触发（idle/run结束时拉起 system run）
      this.notificationQueue.add(task.session_id, payload);
      this.scheduleAutoTrigger(task.session_id);
    }
  }

  private persistRunningTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running" && this.ownedTaskIds.has(task.task_id)) this.persistTask(task);
    }
  }

  private persistTask(task: BackgroundTask): void {
    if (!this.repository || !this.tenantId) return;
    const snapshot: DurableBackgroundTaskRecord = {
      tenant_id: this.tenantId,
      ...task,
      owner_instance_id: task.status === "running" ? this.instanceId : null,
      lease_expires_at: task.status === "running" ? nowSeconds() + this.leaseSeconds : null,
    };
    this.persistence = this.persistence.catch(() => undefined).then(() => this.repository!.upsert(snapshot));
    void this.persistence.catch(() => undefined);
  }
}

function fromDurableRecord(record: DurableBackgroundTaskRecord): BackgroundTask {
  return {
    task_id: record.task_id, description: record.description, output_path: record.output_path,
    started_at: record.started_at, status: record.status, return_code: record.return_code,
    error: record.error, expires_at: record.expires_at, run_id: record.run_id,
    owner_task_id: record.owner_task_id, session_id: record.session_id,
    completed_at: record.completed_at, result_type: record.result_type, kind: record.kind,
    cancel_supported: record.cancel_supported,
  };
}

function isDone(status: BackgroundTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function positiveInt(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : fallback;
}

function positiveIntOrNull(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;
}




