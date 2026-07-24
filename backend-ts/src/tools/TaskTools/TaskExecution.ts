import type { BackgroundTaskService } from "../../services/runtime/background-task-service.js";
import type { SessionNotificationQueue } from "../../services/runtime/session-notification-queue.js";
import type { ToolWaitResult as RuntimeToolWaitResult, ToolExecutionResult, ToolExecContext } from "@ragsystem/agent-sdk";
import {
  isGoalId,
  type GoalStatus,
  type GoalStep,
  type GoalStore,
  type UpdateGoalInput,
} from "../../contracts/runtime/goals.js";
import { toolSuccess, toolError } from "../../services/agent/sdk/tool-results.js";
import {
  asString,
  buildBackgroundNotificationPayload,
  buildBackgroundOutputContent,
  isBackgroundTerminalStatus,
} from "./background-output.js";

export interface GoalCreateInput {
  objective: string;
  successCriteria: string[];
  steps?: GoalStep[] | null | undefined;
  checkpoint?: Record<string, unknown> | null | undefined;
  progress?: Record<string, unknown> | null | undefined;
}

export interface GoalGetInput {
  goalId?: string | null | undefined;
}

export interface GoalUpdateInput {
  goalId?: string | null | undefined;
  objective?: string | null | undefined;
  successCriteria?: string[] | null | undefined;
  steps?: GoalStep[] | null | undefined;
  checkpoint?: Record<string, unknown> | null | undefined;
  progress?: Record<string, unknown> | null | undefined;
  status?: string | null | undefined;
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
    private readonly goals: GoalStore,
  ) {}

  async goalCreate(input: GoalCreateInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "goal_create";
    try {
      const sessionId = resolveTaskSessionId(context);
      const objective = input.objective.trim();
      if (!objective) {
        return toolError(toolName, "goal_create 缺少 objective");
      }
      const goal = await this.goals.create(sessionId, {
        objective,
        successCriteria: input.successCriteria,
        steps: input.steps ?? [],
        checkpoint: input.checkpoint ?? {},
        progress: input.progress ?? {},
      });
      return toolSuccess(
        { goal },
        {
          toolName,
          summary: `已创建 Goal：${objective}`,
          outputType: "json",
          metadata: { goal_id: goal.id, session_id: sessionId, status: goal.status },
        },
      );
    } catch (error) {
      return toolError(toolName, `创建 Goal 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async goalGet(input: GoalGetInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "goal_get";
    try {
      const sessionId = resolveTaskSessionId(context);
      const goalId = input.goalId?.trim() || null;
      if (goalId) assertGoalId(goalId);
      const goal = goalId ? await this.goals.get(sessionId, goalId) : await this.goals.getCurrent(sessionId);
      if (!goal) {
        return toolSuccess(
          { goal: null },
          {
            toolName,
            summary: goalId ? `Goal ${goalId} 不存在` : "当前 Session 没有进行中或已暂停的 Goal",
            outputType: "json",
            metadata: { ...(goalId ? { goal_id: goalId } : {}), found: false },
          },
        );
      }
      return toolSuccess(
        { goal },
        {
          toolName,
          summary: `已获取 Goal：${goal.objective}`,
          outputType: "json",
          metadata: { goal_id: goal.id, status: goal.status },
        },
      );
    } catch (error) {
      return toolError(toolName, `获取 Goal 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async goalUpdate(input: GoalUpdateInput, context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "goal_update";
    try {
      const sessionId = resolveTaskSessionId(context);
      const goalId = input.goalId?.trim() || null;
      if (goalId) assertGoalId(goalId);
      const current = goalId
        ? await this.goals.get(sessionId, goalId)
        : await this.goals.getCurrent(sessionId);
      if (!current) return toolError(toolName, "Goal 不存在");
      assertGoalStatus(input.status);
      if (input.status === "active" && current.status !== "active") {
        return toolError(toolName, "已暂停的 Goal 只能由用户通过会话控件恢复");
      }
      if ((current.status === "completed" || current.status === "blocked")
        && input.status != null && input.status !== current.status) {
        return toolError(toolName, `终态 Goal 不能从 ${current.status} 回退为 ${input.status}`);
      }
      const updates: UpdateGoalInput = {};
      const updatedFields: string[] = [];
      if (input.objective != null) { updates.objective = input.objective; updatedFields.push("objective"); }
      if (input.successCriteria != null) { updates.successCriteria = input.successCriteria; updatedFields.push("success_criteria"); }
      if (input.steps != null) { updates.steps = input.steps; updatedFields.push("steps"); }
      if (input.checkpoint != null) { updates.checkpoint = input.checkpoint; updatedFields.push("checkpoint"); }
      if (input.progress != null) { updates.progress = input.progress; updatedFields.push("progress"); }
      if (input.status != null) { updates.status = input.status as GoalStatus; updatedFields.push("status"); }
      const result = await this.goals.update(sessionId, current.id, updates);
      if (!result) return toolError(toolName, `Goal ${current.id} 不存在`);
      const statusChange = current.status !== result.status ? { from: current.status, to: result.status } : null;
      return toolSuccess(
        { goal: result, updated_fields: updatedFields, status_change: statusChange },
        {
          toolName,
          summary: `已更新 Goal（${updatedFields.join(", ") || "无变更"}）`,
          outputType: "json",
          metadata: { goal_id: result.id, status: result.status },
        },
      );
    } catch (error) {
      return toolError(toolName, `更新 Goal 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async goalList(context: ToolExecContext): Promise<ToolExecutionResult> {
    const toolName = "goal_list";
    try {
      const sessionId = resolveTaskSessionId(context);
      const goals = await this.goals.list(sessionId);
      const summaries = goals.map((goal) => ({ id: goal.id, objective: goal.objective, status: goal.status,
        completed_steps: goal.steps.filter((step) => step.status === "completed").length, total_steps: goal.steps.length,
        updated_at: goal.updated_at }));
      return toolSuccess(
        { goals: summaries },
        {
          toolName,
          summary: `共 ${summaries.length} 个 Goal`,
          outputType: "json",
          metadata: { count: summaries.length, session_id: sessionId },
        },
      );
    } catch (error) {
      return toolError(toolName, `列出 Goal 失败: ${error instanceof Error ? error.message : String(error)}`);
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

function assertGoalId(goalId: string): void {
  if (!isGoalId(goalId)) throw new Error("goal_id 必须是有效 UUID");
}

function assertGoalStatus(
  status: string | null | undefined,
): asserts status is GoalStatus | null | undefined {
  if (status !== null && status !== undefined && !["active", "paused", "completed", "blocked"].includes(status)) {
    throw new Error("status 必须是 active、paused、completed 或 blocked");
  }
}

function clampInteger(value: unknown, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isInteger(value) ? value : min;
  return Math.max(min, Math.min(max, parsed));
}
