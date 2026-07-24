import type { BackgroundTaskService } from "../../services/runtime/background-task-service.js";
import type { SessionNotificationQueue } from "../../services/runtime/session-notification-queue.js";
import type { ToolWaitResult as RuntimeToolWaitResult, ToolExecutionResult, ToolExecContext } from "@ragsystem/agent-sdk";
import {
  isWorkflowTaskId,
  type UpdateWorkflowTaskInput,
  type WorkflowTaskStatus,
  type WorkflowTaskStore,
} from "../../contracts/runtime/workflow-tasks.js";
import { toolSuccess, toolError } from "../../services/agent/sdk/tool-results.js";
import {
  asString,
  buildBackgroundNotificationPayload,
  buildBackgroundOutputContent,
  isBackgroundTerminalStatus,
} from "./background-output.js";

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
  constructor(
    private readonly backgroundTasks: BackgroundTaskService,
    private readonly notificationQueue: SessionNotificationQueue,
    private readonly workflowTasks: WorkflowTaskStore,
  ) {}

  async taskCreate(input: TaskCreateInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "task_create";
    try {
      const sessionId = resolveTaskSessionId(context);
      const subject = input.subject.trim();
      const description = input.description.trim();
      if (!subject || !description) {
        return toolError(toolName, "task_create 缺少 subject 或 description");
      }
      const task = await this.workflowTasks.create(sessionId, {
        subject,
        description,
        activeForm: input.activeForm?.trim() ?? "",
        metadata: input.metadata ?? {},
      });
      return toolSuccess(
        { task },
        {
          toolName,
          summary: `已创建任务 #${task.id}: ${subject}`,
          outputType: "json",
          metadata: { task_id: task.id, session_id: sessionId },
        },
      );
    } catch (error) {
      return toolError(toolName, `创建任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async taskGet(input: TaskGetInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "task_get";
    try {
      const taskId = input.taskId.trim();
      assertWorkflowTaskId(taskId);
      const task = await this.workflowTasks.get(resolveTaskSessionId(context), taskId);
      if (!task) {
        return toolSuccess(
          { task: null },
          {
            toolName,
            summary: `任务 #${taskId} 不存在`,
            outputType: "json",
            metadata: { task_id: taskId, found: false },
          },
        );
      }
      return toolSuccess(
        { task },
        {
          toolName,
          summary: `已获取任务 #${taskId}: ${task.subject}`,
          outputType: "json",
          metadata: { task_id: taskId, status: task.status },
        },
      );
    } catch (error) {
      return toolError(toolName, `获取任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async taskUpdate(input: TaskUpdateInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "task_update";
    try {
      const sessionId = resolveTaskSessionId(context);
      const taskId = input.taskId.trim();
      assertWorkflowTaskId(taskId);
      assertWorkflowTaskStatus(input.status);
      assertWorkflowDependencies(taskId, input.addBlocks, input.addBlockedBy);
      if (input.status === "deleted") {
        const oldTask = await this.workflowTasks.get(sessionId, taskId);
        if (!oldTask) {
          return toolError(toolName, `任务 #${taskId} 不存在`);
        }
        const deleted = await this.workflowTasks.delete(sessionId, taskId);
        if (!deleted) {
          return toolError(toolName, `任务 #${taskId} 不存在`);
        }
        return toolSuccess(
          {
            success: true,
            task_id: taskId,
            updated_fields: ["status"],
            status_change: { from: oldTask.status, to: "deleted" },
          },
          {
            toolName,
            summary: `已删除任务 #${taskId}`,
            outputType: "json",
            metadata: { task_id: taskId, status: "deleted" },
          },
        );
      }
      const oldTask = await this.workflowTasks.get(sessionId, taskId);
      const oldStatus = oldTask?.status ?? null;
      const updates: UpdateWorkflowTaskInput = {};
      const updatedFields: string[] = [];

      addOptionalStringUpdate(updates, updatedFields, "subject", input.subject);
      addOptionalStringUpdate(updates, updatedFields, "description", input.description);
      addOptionalStringUpdate(updates, updatedFields, "active_form", input.activeForm);
      addOptionalStringUpdate(updates, updatedFields, "owner", input.owner);
      addOptionalStringUpdate(updates, updatedFields, "status", input.status);

      if ((input.addBlocks ?? []).length) {
        updatedFields.push("blocks");
      }
      if ((input.addBlockedBy ?? []).length) {
        updatedFields.push("blocked_by");
      }
      if (input.metadata !== null && input.metadata !== undefined) {
        updatedFields.push("metadata");
      }
      updates.addBlocks = input.addBlocks ?? [];
      updates.addBlockedBy = input.addBlockedBy ?? [];
      updates.metadata = input.metadata;

      const result = await this.workflowTasks.update(sessionId, taskId, updates);
      if (!result) {
        return toolError(toolName, `任务 #${taskId} 不存在`);
      }

      const statusChange = oldStatus !== result.status ? { from: oldStatus, to: result.status } : null;
      return toolSuccess(
        {
          success: true,
          task_id: taskId,
          updated_fields: updatedFields,
          status_change: statusChange,
        },
        {
          toolName,
          summary: `已更新任务 #${taskId}（${updatedFields.join(", ") || "无变更"}）`,
          outputType: "json",
          metadata: { task_id: taskId, status: result.status },
        },
      );
    } catch (error) {
      return toolError(toolName, `更新任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async taskList(context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "task_list";
    try {
      const sessionId = resolveTaskSessionId(context);
      const tasks = await this.workflowTasks.list(sessionId);
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
      return toolSuccess(
        { tasks: summaries },
        {
          toolName,
          summary: `共 ${summaries.length} 个任务`,
          outputType: "json",
          metadata: { count: summaries.length, session_id: sessionId },
        },
      );
    } catch (error) {
      return toolError(toolName, `列出任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  taskOutput(input: TaskOutputInput): ToolExecutionResult {
    const toolName = "task_output";
    try {
      const taskId = input.taskId.trim();
      const snapshot = this.backgroundTasks.getTaskSnapshot(taskId);
      if (!snapshot) {
        return toolError(toolName, `后台任务 ${taskId} 不存在`);
      }
      const rawOutput = this.backgroundTasks.readOutput(taskId, clampInteger(input.maxChars ?? 8000, 200, Number.MAX_SAFE_INTEGER));
      const content = buildBackgroundOutputContent(snapshot, rawOutput);
      const completed = Boolean(content.completed);
      const waitTimeoutMs = clampInteger(input.timeout ?? 30000, 0, 600000);
      if (input.block && !completed) {
        return toolSuccess(
          {
            ...content,
            background_task_id: taskId,
            suggest_wait: true,
            wait_timeout_ms: waitTimeoutMs,
          },
          {
            toolName,
            summary: `后台任务 ${taskId} 仍在运行，已进入等待`,
            outputType: "json",
            metadata: {
              background_task_id: taskId,
              suggest_wait: true,
              wait_timeout_ms: waitTimeoutMs,
            },
          },
        );
      }
      return toolSuccess(content, {
        toolName,
        summary: completed ? `后台任务 ${taskId} 已完成，状态：${content.status}` : `后台任务 ${taskId} 当前状态：${content.status}`,
        outputType: "json",
        metadata: { task_id: taskId, status: content.status, completed },
      });
    } catch (error) {
      return toolError(toolName, `读取后台任务失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  taskStop(input: TaskStopInput): ToolExecutionResult {
    const toolName = "task_stop";
    try {
      const taskId = input.taskId.trim();
      const snapshot = this.backgroundTasks.getTaskSnapshot(taskId);
      if (!snapshot) {
        return toolError(toolName, `后台任务 ${taskId} 不存在`);
      }
      const status = String(snapshot.status ?? "");
      const cancelSupported = Boolean(snapshot.cancel_supported);
      if (["completed", "failed", "cancelled"].includes(status)) {
        return toolSuccess(
          {
            task_id: taskId,
            found: true,
            stop_requested: false,
            previous_status: status,
            current_status: status,
            cancel_supported: cancelSupported,
          },
          {
            toolName,
            summary: `后台任务 ${taskId} 已结束，无需停止`,
            outputType: "json",
            metadata: { task_id: taskId, status },
          },
        );
      }
      if (!cancelSupported) {
        return toolError(toolName, `后台任务 ${taskId} 当前类型不支持可靠停止`, { task_id: taskId, status });
      }
      const stopped = this.backgroundTasks.cancel(taskId);
      const updated = this.backgroundTasks.getTaskSnapshot(taskId) ?? snapshot;
      const currentStatus = String(updated.status ?? status);
      if (!stopped) {
        return toolError(toolName, `后台任务 ${taskId} 停止失败`, { task_id: taskId, status: currentStatus });
      }
      return toolSuccess(
        {
          task_id: taskId,
          found: true,
          stop_requested: true,
          previous_status: status,
          current_status: currentStatus,
          cancel_supported: Boolean(updated.cancel_supported),
        },
        {
          toolName,
          summary: `已请求停止后台任务 ${taskId}`,
          outputType: "json",
          metadata: { task_id: taskId, status: currentStatus },
        },
      );
    } catch (error) {
      return toolError(toolName, `停止后台任务失败: ${error instanceof Error ? error.message : String(error)}`);
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
        const sessionId = asString(snapshot.session_id)?.trim();
        if (sessionId) {
          this.notificationQueue.markConsumed(sessionId, taskId);
        }
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

function resolveTaskSessionId(context: ToolExecContext): string {
  return context.sessionId?.trim() || "default";
}

function addOptionalStringUpdate(
  updates: UpdateWorkflowTaskInput,
  updatedFields: string[],
  key: "subject" | "description" | "active_form" | "owner" | "status",
  value: string | null | undefined,
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (key === "active_form") {
    updates.activeForm = value;
  } else if (key === "status") {
    updates.status = value as WorkflowTaskStatus;
  } else {
    updates[key] = value;
  }
  updatedFields.push(key);
}

function assertWorkflowTaskId(taskId: string): void {
  if (!isWorkflowTaskId(taskId)) {
    throw new Error("task_id 必须是正整数任务 ID");
  }
}

function assertWorkflowTaskStatus(
  status: string | null | undefined,
): asserts status is WorkflowTaskStatus | "deleted" | null | undefined {
  if (status !== null && status !== undefined && !["pending", "in_progress", "completed", "deleted"].includes(status)) {
    throw new Error("status 必须是 pending、in_progress、completed 或 deleted");
  }
}

function assertWorkflowDependencies(taskId: string, addBlocks?: readonly string[] | null, addBlockedBy?: readonly string[] | null): void {
  for (const dependencyId of [...(addBlocks ?? []), ...(addBlockedBy ?? [])]) {
    assertWorkflowTaskId(dependencyId);
    if (dependencyId === taskId) {
      throw new Error("任务不能依赖自身");
    }
  }
}

function clampInteger(value: unknown, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isInteger(value) ? value : min;
  return Math.max(min, Math.min(max, parsed));
}
