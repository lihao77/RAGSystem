import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolExecutionResult } from "./memory-tool-service.js";
import type { BackgroundTaskService } from "./background-task-service.js";
import type { RuntimeToolExecutionContext, RuntimeToolWaitResult } from "./runtime-tool-types.js";

type TaskStatus = "pending" | "in_progress" | "completed" | "deleted" | string;

interface StoredTask {
  id: string;
  subject: string;
  description: string;
  active_form: string;
  owner: string;
  status: TaskStatus;
  blocks: string[];
  blocked_by: string[];
  metadata: Record<string, unknown>;
}

export interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

export interface TaskGetInput {
  taskId: string;
}

export interface TaskUpdateInput {
  taskId: string;
  subject?: string | null | undefined;
  description?: string | null | undefined;
  activeForm?: string | null | undefined;
  owner?: string | null | undefined;
  status?: string | null | undefined;
  addBlocks?: string[] | null | undefined;
  addBlockedBy?: string[] | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

export interface TaskOutputInput {
  taskId: string;
  block?: boolean | null | undefined;
  timeout?: number | null | undefined;
  maxChars?: number | null | undefined;
}

export interface TaskStopInput {
  taskId: string;
}

export class TaskToolService {
  private readonly dataRoot: string;

  constructor(
    private readonly backgroundTasks: BackgroundTaskService,
    options: { dataRoot?: string | undefined } = {},
  ) {
    this.dataRoot = path.resolve(options.dataRoot ?? path.join(os.homedir(), ".ragsystem"));
  }

  taskCreate(input: TaskCreateInput, context: RuntimeToolExecutionContext): ToolExecutionResult {
    const toolName = "task_create";
    try {
      const sessionId = resolveTaskSessionId(context);
      const subject = input.subject.trim();
      const description = input.description.trim();
      if (!subject || !description) {
        return errorResult("task_create 缺少 subject 或 description", toolName);
      }
      const task = this.createTask(sessionId, {
        subject,
        description,
        active_form: input.activeForm?.trim() ?? "",
        owner: "",
        status: "pending",
        blocks: [],
        blocked_by: [],
        metadata: input.metadata ?? {},
      });
      return successResult(
        { task },
        {
          summary: `已创建任务 #${task.id}: ${subject}`,
          outputType: "json",
          metadata: { task_id: task.id, session_id: sessionId },
          toolName,
        },
      );
    } catch (error) {
      return errorResult(`创建任务失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  taskGet(input: TaskGetInput, context: RuntimeToolExecutionContext): ToolExecutionResult {
    const toolName = "task_get";
    try {
      const taskId = input.taskId.trim();
      const task = this.getTask(resolveTaskSessionId(context), taskId);
      if (!task) {
        return successResult(
          { task: null },
          {
            summary: `任务 #${taskId} 不存在`,
            outputType: "json",
            metadata: { task_id: taskId, found: false },
            toolName,
          },
        );
      }
      return successResult(
        { task },
        {
          summary: `已获取任务 #${taskId}: ${task.subject}`,
          outputType: "json",
          metadata: { task_id: taskId, status: task.status },
          toolName,
        },
      );
    } catch (error) {
      return errorResult(`获取任务失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  taskUpdate(input: TaskUpdateInput, context: RuntimeToolExecutionContext): ToolExecutionResult {
    const toolName = "task_update";
    try {
      const sessionId = resolveTaskSessionId(context);
      const taskId = input.taskId.trim();
      const oldTask = this.getTask(sessionId, taskId);
      const oldStatus = oldTask?.status ?? null;
      const updates: Partial<StoredTask> = {};
      const updatedFields: string[] = [];

      addOptionalStringUpdate(updates, updatedFields, "subject", input.subject);
      addOptionalStringUpdate(updates, updatedFields, "description", input.description);
      addOptionalStringUpdate(updates, updatedFields, "active_form", input.activeForm);
      addOptionalStringUpdate(updates, updatedFields, "owner", input.owner);
      addOptionalStringUpdate(updates, updatedFields, "status", input.status);

      const updateOptions = {
        addBlocks: input.addBlocks ?? [],
        addBlockedBy: input.addBlockedBy ?? [],
        metadata: input.metadata,
      };
      if (updateOptions.addBlocks.length) {
        updatedFields.push("blocks");
      }
      if (updateOptions.addBlockedBy.length) {
        updatedFields.push("blocked_by");
      }
      if (updateOptions.metadata !== null && updateOptions.metadata !== undefined) {
        updatedFields.push("metadata");
      }

      const result = this.updateTask(sessionId, taskId, updates, updateOptions);
      if (input.status === "deleted") {
        return successResult(
          {
            success: true,
            task_id: taskId,
            updated_fields: ["status"],
            status_change: { from: oldStatus, to: "deleted" },
          },
          {
            summary: `已删除任务 #${taskId}`,
            outputType: "json",
            metadata: {},
            toolName,
          },
        );
      }
      if (!result) {
        return errorResult(`任务 #${taskId} 不存在`, toolName);
      }

      const statusChange = oldStatus !== result.status ? { from: oldStatus, to: result.status } : null;
      return successResult(
        {
          success: true,
          task_id: taskId,
          updated_fields: updatedFields,
          status_change: statusChange,
        },
        {
          summary: `已更新任务 #${taskId}（${updatedFields.join(", ") || "无变更"}）`,
          outputType: "json",
          metadata: { task_id: taskId, status: result.status },
          toolName,
        },
      );
    } catch (error) {
      return errorResult(`更新任务失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  taskList(context: RuntimeToolExecutionContext): ToolExecutionResult {
    const toolName = "task_list";
    try {
      const sessionId = resolveTaskSessionId(context);
      const tasks = this.listTasks(sessionId);
      const statusById = new Map(tasks.map((task) => [task.id, task.status]));
      const summaries = tasks
        .filter((task) => !task.metadata._internal)
        .map((task) => ({
          id: task.id,
          subject: task.subject,
          status: task.status,
          owner: task.owner,
          blocked_by: task.blocked_by.filter((id) => statusById.get(String(id)) !== "completed"),
        }));
      return successResult(
        { tasks: summaries },
        {
          summary: `共 ${summaries.length} 个任务`,
          outputType: "json",
          metadata: { count: summaries.length, session_id: sessionId },
          toolName,
        },
      );
    } catch (error) {
      return errorResult(`列出任务失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  taskOutput(input: TaskOutputInput): ToolExecutionResult {
    const toolName = "task_output";
    try {
      const taskId = input.taskId.trim();
      const snapshot = this.backgroundTasks.getTaskSnapshot(taskId);
      if (!snapshot) {
        return errorResult(`后台任务 ${taskId} 不存在`, toolName);
      }
      const rawOutput = this.backgroundTasks.readOutput(taskId, clampInteger(input.maxChars ?? 8000, 200, Number.MAX_SAFE_INTEGER));
      const content = buildBackgroundOutputContent(snapshot, rawOutput);
      const completed = Boolean(content.completed);
      const waitTimeoutMs = clampInteger(input.timeout ?? 30000, 0, 600000);
      if (input.block && !completed) {
        return successResult(
          {
            ...content,
            background_task_id: taskId,
            suggest_wait: true,
            wait_timeout_ms: waitTimeoutMs,
          },
          {
            summary: `后台任务 ${taskId} 仍在运行，已进入等待`,
            outputType: "json",
            metadata: {
              background_task_id: taskId,
              suggest_wait: true,
              wait_timeout_ms: waitTimeoutMs,
            },
            toolName,
          },
        );
      }
      return successResult(content, {
        summary: completed ? `后台任务 ${taskId} 已完成，状态：${content.status}` : `后台任务 ${taskId} 当前状态：${content.status}`,
        outputType: "json",
        metadata: { task_id: taskId, status: content.status, completed },
        toolName,
      });
    } catch (error) {
      return errorResult(`读取后台任务失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  taskStop(input: TaskStopInput): ToolExecutionResult {
    const toolName = "task_stop";
    try {
      const taskId = input.taskId.trim();
      const snapshot = this.backgroundTasks.getTaskSnapshot(taskId);
      if (!snapshot) {
        return errorResult(`后台任务 ${taskId} 不存在`, toolName);
      }
      const status = String(snapshot.status ?? "");
      const cancelSupported = Boolean(snapshot.cancel_supported);
      if (["completed", "failed", "cancelled"].includes(status)) {
        return successResult(
          {
            task_id: taskId,
            found: true,
            stop_requested: false,
            previous_status: status,
            current_status: status,
            cancel_supported: cancelSupported,
          },
          {
            summary: `后台任务 ${taskId} 已结束，无需停止`,
            outputType: "json",
            metadata: { task_id: taskId, status },
            toolName,
          },
        );
      }
      if (!cancelSupported) {
        return errorResult(`后台任务 ${taskId} 当前类型不支持可靠停止`, toolName, { task_id: taskId, status });
      }
      const stopped = this.backgroundTasks.cancel(taskId);
      const updated = this.backgroundTasks.getTaskSnapshot(taskId) ?? snapshot;
      const currentStatus = String(updated.status ?? status);
      if (!stopped) {
        return errorResult(`后台任务 ${taskId} 停止失败`, toolName, { task_id: taskId, status: currentStatus });
      }
      return successResult(
        {
          task_id: taskId,
          found: true,
          stop_requested: true,
          previous_status: status,
          current_status: currentStatus,
          cancel_supported: Boolean(updated.cancel_supported),
        },
        {
          summary: `已请求停止后台任务 ${taskId}`,
          outputType: "json",
          metadata: { task_id: taskId, status: currentStatus },
          toolName,
        },
      );
    } catch (error) {
      return errorResult(`停止后台任务失败: ${error instanceof Error ? error.message : String(error)}`, toolName);
    }
  }

  async waitForBackgroundTask(input: {
    taskId: string;
    timeoutMs?: number | null | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<RuntimeToolWaitResult> {
    const taskId = input.taskId.trim();
    const timeoutMs = clampInteger(input.timeoutMs ?? 30000, 0, 600000);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const snapshot = this.backgroundTasks.getTaskSnapshot(taskId);
      if (!snapshot) {
        return {
          success: false,
          timeout: false,
          payloads: [buildBackgroundNotificationPayload({ task_id: taskId, status: "missing" }, true)],
        };
      }
      const status = asString(snapshot.status) ?? "running";
      if (isBackgroundTerminalStatus(status)) {
        const payload = buildBackgroundNotificationPayload(snapshot, false);
        return {
          success: payload.success === true,
          timeout: false,
          payloads: [payload],
        };
      }
      if (Date.now() >= deadline || timeoutMs === 0) {
        return {
          success: false,
          timeout: true,
          payloads: [buildBackgroundNotificationPayload(snapshot, true)],
        };
      }
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())), input.signal);
    }
  }

  private createTask(sessionId: string, task: Omit<StoredTask, "id">): StoredTask {
    const taskId = this.nextTaskId(sessionId);
    const stored: StoredTask = { id: taskId, ...task };
    this.writeTask(sessionId, stored);
    return stored;
  }

  private getTask(sessionId: string, taskId: string): StoredTask | null {
    const filePath = this.taskPath(sessionId, taskId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return normalizeTask(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  }

  private listTasks(sessionId: string): StoredTask[] {
    const dir = this.taskDir(sessionId);
    const tasks: StoredTask[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "counter.json") {
        continue;
      }
      try {
        const task = normalizeTask(JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8")) as unknown);
        tasks.push(task);
      } catch {
        // Match Python's tolerant list_tasks behavior.
      }
    }
    return tasks.sort((left, right) => numericTaskId(left.id) - numericTaskId(right.id));
  }

  private updateTask(
    sessionId: string,
    taskId: string,
    updates: Partial<StoredTask>,
    options: {
      addBlocks: string[];
      addBlockedBy: string[];
      metadata?: Record<string, unknown> | null | undefined;
    },
  ): StoredTask | null {
    const task = this.getTask(sessionId, taskId);
    if (!task) {
      return null;
    }
    if (updates.status === "deleted") {
      fs.rmSync(this.taskPath(sessionId, taskId), { force: true });
      return null;
    }
    Object.assign(task, updates);

    for (const blockedId of options.addBlocks.map(String)) {
      pushUnique(task.blocks, blockedId);
      const other = this.getTask(sessionId, blockedId);
      if (other) {
        pushUnique(other.blocked_by, taskId);
        this.writeTask(sessionId, other);
      }
    }
    for (const blockerId of options.addBlockedBy.map(String)) {
      pushUnique(task.blocked_by, blockerId);
      const other = this.getTask(sessionId, blockerId);
      if (other) {
        pushUnique(other.blocks, taskId);
        this.writeTask(sessionId, other);
      }
    }
    if (options.metadata) {
      for (const [key, value] of Object.entries(options.metadata)) {
        if (value === null) {
          delete task.metadata[key];
        } else {
          task.metadata[key] = value;
        }
      }
    }

    this.writeTask(sessionId, task);
    return task;
  }

  private nextTaskId(sessionId: string): string {
    const counterPath = path.join(this.taskDir(sessionId), "counter.json");
    const current = fs.existsSync(counterPath)
      ? Number((JSON.parse(fs.readFileSync(counterPath, "utf8")) as { counter?: unknown }).counter ?? 0)
      : 0;
    const next = Number.isFinite(current) ? Math.trunc(current) + 1 : 1;
    fs.writeFileSync(counterPath, JSON.stringify({ counter: next }), "utf8");
    return String(next);
  }

  private writeTask(sessionId: string, task: StoredTask): void {
    fs.writeFileSync(this.taskPath(sessionId, task.id), `${JSON.stringify(task, null, 2)}\n`, "utf8");
  }

  private taskDir(sessionId: string): string {
    const dir = path.join(this.dataRoot, "tasks", sessionId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private taskPath(sessionId: string, taskId: string): string {
    return path.join(this.taskDir(sessionId), `${taskId}.json`);
  }
}

function buildBackgroundOutputContent(snapshot: Record<string, unknown>, rawOutput: string | null): Record<string, unknown> {
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
    completed: status === "completed" || status === "failed" || status === "cancelled",
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

function buildBackgroundNotificationPayload(snapshot: Record<string, unknown>, timeout: boolean): Record<string, unknown> {
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

function isBackgroundTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("等待后台任务期间被取消"));
  }
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("等待后台任务期间被取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveTaskSessionId(context: RuntimeToolExecutionContext): string {
  return context.sessionId?.trim() || "default";
}

function normalizeTask(value: unknown): StoredTask {
  const record = isRecord(value) ? value : {};
  return {
    id: String(record.id ?? ""),
    subject: String(record.subject ?? ""),
    description: String(record.description ?? ""),
    active_form: String(record.active_form ?? ""),
    owner: String(record.owner ?? ""),
    status: String(record.status ?? "pending"),
    blocks: Array.isArray(record.blocks) ? record.blocks.map(String) : [],
    blocked_by: Array.isArray(record.blocked_by) ? record.blocked_by.map(String) : [],
    metadata: isRecord(record.metadata) ? { ...record.metadata } : {},
  };
}

function addOptionalStringUpdate(
  updates: Partial<StoredTask>,
  updatedFields: string[],
  key: "subject" | "description" | "active_form" | "owner" | "status",
  value: string | null | undefined,
): void {
  if (value === null || value === undefined) {
    return;
  }
  updates[key] = value;
  updatedFields.push(key);
}

function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
    toolName: string;
  },
): ToolExecutionResult<T> {
  return {
    success: true,
    tool_name: input.toolName,
    summary: input.summary,
    answer: null,
    output_type: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llm_hint: null,
  };
}

function errorResult(message: string, toolName: string, metadata: Record<string, unknown> = {}): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
      ...metadata,
    },
    artifacts: [],
    llm_hint: null,
  };
}

function numericTaskId(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function clampInteger(value: unknown, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isInteger(value) ? value : min;
  return Math.max(min, Math.min(max, parsed));
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
