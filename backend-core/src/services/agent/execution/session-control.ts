import type {
  AgentExecuteResult,
  CollaborateRequest,
  ExecuteRequest,
} from "../../../contracts/execution/execution.js";
import type { AgentExecutionEventPublisher } from "./event-publisher.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { PendingInteractionPort } from "../../../contracts/runtime/pending-interactions.js";
import type { ClientEventPublisherPort } from "../../../contracts/runtime/core-runtime-ports.js";
import type { RuntimeStorage } from "../../../contracts/storage/runtime-storage.js";
import { GoalStateConflictError, GoalUserInterrupt, type Goal, type GoalStore } from "../../../contracts/runtime/goals.js";
import { recordGoalStatusMessage } from "./goal-control.js";

export interface SessionControlApi {
  stopSession(sessionId: string): Promise<boolean>;
  startGoal(sessionId: string): Promise<Goal | null>;
  collaborateSequentially(
    request: CollaborateRequest,
    requestId: string,
  ): Promise<{ results: AgentExecuteResult[]; session_id: string; total_tasks: number }>;
  collaborate(
    request: CollaborateRequest,
    requestId: string,
  ): Promise<{ results: AgentExecuteResult[]; session_id: string; total_tasks: number }>;
}

export interface SessionControlDeps {
  statusTracker: AgentExecutionStatusTracker;
  eventPublisher: AgentExecutionEventPublisher;
  pendingInteractions: PendingInteractionPort;
  runtimeStorage: RuntimeStorage;
  goalStore?: GoalStore | null;
  clientEvents: Pick<ClientEventPublisherPort, "publish" | "deliver">;
  /** collaborateSequentially 顺序复用 executeSynchronously（由 launchers 提供，注入打破环）。 */
  executeSynchronously: (request: ExecuteRequest, requestId: string) => Promise<AgentExecuteResult>;
}

/** stopSession 中断 + collaborateSequentially 顺序多任务（复用 executeSynchronously）。 */
export function createSessionControl(deps: SessionControlDeps): SessionControlApi {
  const executeTask = async (
    taskItem: CollaborateRequest["tasks"][number],
    sessionId: string,
    userId: CollaborateRequest["userId"],
    requestId: string,
    index: number,
    overrides: Pick<CollaborateRequest, "selected_llm" | "thinking_level">,
  ): Promise<AgentExecuteResult> => {
    const executeRequest: ExecuteRequest = {
      task: taskItem.task,
      session_id: sessionId,
      userId,
      // 请求级覆盖三态透传：undefined = 继承会话设定；null = 清除；有值 = 生效。
      ...(overrides.selected_llm !== undefined ? { selected_llm: overrides.selected_llm } : {}),
      ...(overrides.thinking_level !== undefined ? { thinking_level: overrides.thinking_level } : {}),
    };
    if (taskItem.agent !== undefined) executeRequest.agent = taskItem.agent;
    try {
      return await deps.executeSynchronously(executeRequest, `${requestId}:${index + 1}`);
    } catch (error) {
      return failedCollaborateResult(sessionId, taskItem.agent ?? null, error);
    }
  };

  const runCollaborate = async (request: CollaborateRequest, requestId: string): Promise<{ results: AgentExecuteResult[]; session_id: string; total_tasks: number }> => {
    const sessionId = request.session_id?.trim() || cryptoRandom();
    const overrides = { selected_llm: request.selected_llm, thinking_level: request.thinking_level };
    const results = request.mode === "parallel"
      ? await Promise.all(request.tasks.map((taskItem, index) => executeTask(taskItem, sessionId, request.userId, requestId, index, overrides)))
      : await runSequential(request, sessionId, request.userId, requestId, executeTask);
    return { results, session_id: sessionId, total_tasks: request.tasks.length };
  };

  return {
    async startGoal(sessionId) {
      const store = deps.goalStore;
      if (!store) return null;
      const current = await store.getCurrent(sessionId) ?? (await store.list(sessionId))[0] ?? null;
      if (!current || current.status === "active") return current;
      const guard = { expectedGeneration: current.continuation_generation };
      const goal = current.status === "blocked" && store.restartBlocked
        ? await store.restartBlocked(sessionId, current.id, guard)
        : await store.update(sessionId, current.id, { status: "active" }, guard);
      if (goal) await recordGoalStatusMessage(goal, deps.runtimeStorage, deps.clientEvents);
      return goal;
    },
    async stopSession(sessionId) {
      let goal = await deps.goalStore?.getCurrent(sessionId) ?? null;
      let didPause = false;
      while (goal?.status === "active") {
        try {
          goal = await deps.goalStore!.update(sessionId, goal.id, { status: "paused" }, {
            expectedGeneration: goal.continuation_generation,
          });
          didPause = goal?.status === "paused";
        } catch (error) {
          if (!(error instanceof GoalStateConflictError)) throw error;
          // A concurrent terminal transition wins over the stale pause request.
          goal = await deps.goalStore!.getCurrent(sessionId);
        }
      }
      const pausedGoal = goal?.status === "paused" ? goal : null;
      const handle = deps.statusTracker.getRunningHandleBySession(sessionId);
      if (!handle) {
        // 维护中的手动 /compact 也是用户视角"正在执行的指令"：与 run 停止同一入口、
        // 同一按钮（allowed_actions 放行 stop_run）。中止后由 slash handler 自己收尾
        // （compression_finished + command_result + 释放租约），这里只触发。
        if (deps.statusTracker.cancelMaintenanceAbort(sessionId, "user_stop")) {
          if (didPause && pausedGoal) await recordGoalStatusMessage(pausedGoal, deps.runtimeStorage, deps.clientEvents);
          return true;
        }
        const result = await deps.runtimeStorage.operations.interruptSession({
          sessionId,
          ...(pausedGoal ? { pausedGoal: { id: pausedGoal.id, objective: pausedGoal.objective } } : {}),
        });
        await deps.pendingInteractions.cancelSession(sessionId, "suspended run cancelled");
        await deps.clientEvents.deliver(result.records.map((record) => record.outbox));
        if (didPause && pausedGoal && !result.interruptedRuns.some((run) => run.parentRunId === null)) {
          await recordGoalStatusMessage(pausedGoal, deps.runtimeStorage, deps.clientEvents);
        }
        return Boolean(pausedGoal) || result.interruptedRuns.length > 0 || result.cancelledInteractions > 0;
      }
      // A live stop targets the attached foreground root. Background children
      // own a separate lease and therefore finish independently; when no
      // foreground handle remains, interruptSession closes every detached run.
      deps.eventPublisher.publishUserInterrupt(handle.status, "user_stop");
      const runId = handle.status.run_id;
      const reason = pausedGoal ? new GoalUserInterrupt(pausedGoal) : new Error("user_stop");
      if (runId) deps.statusTracker.cancelRun(runId, reason);
      else handle.abortController.abort(reason);
      return true;
    },
    async collaborateSequentially(request, requestId) {
      return runCollaborate({ ...request, mode: "sequential" }, requestId);
    },
    collaborate: runCollaborate,
  };
}

type CollaborateExecuteTask = (
  taskItem: CollaborateRequest["tasks"][number],
  sessionId: string,
  userId: CollaborateRequest["userId"],
  requestId: string,
  index: number,
  overrides: Pick<CollaborateRequest, "selected_llm" | "thinking_level">,
) => Promise<AgentExecuteResult>;

async function runSequential(
  request: CollaborateRequest,
  sessionId: string,
  userId: CollaborateRequest["userId"],
  requestId: string,
  executeTask: CollaborateExecuteTask,
): Promise<AgentExecuteResult[]> {
  const results: AgentExecuteResult[] = [];
  const overrides = { selected_llm: request.selected_llm, thinking_level: request.thinking_level };
  for (const [index, taskItem] of request.tasks.entries()) {
    const result = await executeTask(taskItem, sessionId, userId, requestId, index, overrides);
    results.push(result);
    if (!result.success) break;
  }
  return results;
}

function failedCollaborateResult(sessionId: string, agentName: string | null, error: unknown): AgentExecuteResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    answer: null,
    content_parts: [{ type: "text", text: message }],
    agent_name: agentName,
    execution_time: null,
    tool_calls: [],
    metadata: { source: "collaborate", isolated_failure: true },
    session_id: sessionId,
    run_id: null,
    task_id: null,
    error: message,
  };
}

function cryptoRandom(): string {
  return crypto.randomUUID();
}
