import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { InMemoryEventBus } from "./event-bus.js";

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

export type BackgroundTaskNotificationPayload = Record<string, unknown>;

export interface SpawnBashInput {
  command: string;
  bashExecutable: string | null;
  cwd: string;
  outputDir: string;
  description?: string | null;
  env?: Record<string, string | undefined> | undefined;
  maxRuntimeSeconds?: number | null | undefined;
  eventBus?: InMemoryEventBus | null | undefined;
  sessionId?: string | null | undefined;
  runId?: string | null | undefined;
  ownerTaskId?: string | null | undefined;
}

export class BackgroundTaskService {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly processes = new Map<string, ChildProcess>();
  private readonly pendingNotificationsBySession = new Map<string, BackgroundTaskNotificationPayload[]>();
  private readonly consumedNotificationTaskIdsBySession = new Map<string, Set<string>>();
  private readonly retentionSeconds: number;

  constructor(options: { retentionSeconds?: number | undefined } = {}) {
    this.retentionSeconds = positiveInt(options.retentionSeconds, 2 * 60 * 60);
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
        }
        output.end(() => {
          const snapshot = this.getTask(taskId);
          if (snapshot) {
            this.publishCompleted(snapshot, input.eventBus ?? null);
          }
        });
      });
    } catch (error) {
      output.end();
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.result_type = "bash_output";
      task.completed_at = nowSeconds();
    }

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

  drainPendingNotifications(sessionId: string, excludeBackgroundTaskIds: string[] = []): BackgroundTaskNotificationPayload[] {
    const pending = this.pendingNotificationsBySession.get(sessionId);
    if (!pending?.length) {
      return [];
    }
    const excluded = new Set(excludeBackgroundTaskIds.map(String));
    const drained: BackgroundTaskNotificationPayload[] = [];
    const retained: BackgroundTaskNotificationPayload[] = [];
    for (const payload of pending) {
      const taskId = asString(payload.background_task_id) ?? asString(payload.task_id);
      if (taskId && excluded.has(taskId)) {
        retained.push(payload);
      } else {
        drained.push(payload);
      }
    }
    if (retained.length) {
      this.pendingNotificationsBySession.set(sessionId, retained);
    } else {
      this.pendingNotificationsBySession.delete(sessionId);
    }
    return drained;
  }

  clearPendingNotification(sessionId: string | null | undefined, taskId: string): void {
    const normalizedSessionId = normalizeString(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const consumed = this.consumedNotificationTaskIdsBySession.get(normalizedSessionId) ?? new Set<string>();
    consumed.add(taskId);
    this.consumedNotificationTaskIdsBySession.set(normalizedSessionId, consumed);
    const pending = this.pendingNotificationsBySession.get(normalizedSessionId);
    if (!pending?.length) {
      return;
    }
    const retained = pending.filter((payload) => {
      const payloadTaskId = asString(payload.background_task_id) ?? asString(payload.task_id);
      return payloadTaskId !== taskId;
    });
    if (retained.length) {
      this.pendingNotificationsBySession.set(normalizedSessionId, retained);
    } else {
      this.pendingNotificationsBySession.delete(normalizedSessionId);
    }
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    const proc = this.processes.get(taskId);
    if (!task || isDone(task.status) || !task.cancel_supported) {
      return false;
    }
    if (proc) {
      terminateProcessTree(proc.pid, false);
      setTimeout(() => terminateProcessTree(proc.pid, true), 500);
    }
    task.status = "cancelled";
    task.completed_at = nowSeconds();
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

  private publishCompleted(task: BackgroundTask, eventBus: InMemoryEventBus | null): void {
    const payload = {
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
      const consumed = this.consumedNotificationTaskIdsBySession.get(task.session_id);
      if (consumed?.has(task.task_id)) {
        consumed.delete(task.task_id);
        if (consumed.size === 0) {
          this.consumedNotificationTaskIdsBySession.delete(task.session_id);
        }
      } else {
        const pending = this.pendingNotificationsBySession.get(task.session_id) ?? [];
        pending.push(payload);
        this.pendingNotificationsBySession.set(task.session_id, pending);
      }
    }
    if (!eventBus || !task.session_id) {
      return;
    }
    eventBus.publish(task.session_id, {
      type: "background.task.completed",
      session_id: task.session_id,
      ...(task.run_id ? { run_id: task.run_id } : {}),
      data: payload,
      content: payload,
    });
  }
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

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function terminateProcessTree(pid: number | undefined, force: boolean): void {
  if (!pid) {
    return;
  }
  if (process.platform === "win32") {
    const args = ["/pid", String(pid), "/t"];
    if (force) {
      args.push("/f");
    }
    const killer = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => undefined);
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}
