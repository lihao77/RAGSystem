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

export interface SessionControlApi {
  stopSession(sessionId: string): Promise<boolean>;
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
  clientEvents: Pick<ClientEventPublisherPort, "publish" | "deliver">;
  /** collaborateSequentially 顺序复用 executeSynchronously（由 launchers 提供，注入打破环）。 */
  executeSynchronously: (request: ExecuteRequest, requestId: string) => Promise<AgentExecuteResult>;
}

/** stopSession 中断 + collaborateSequentially 顺序多任务（复用 executeSynchronously）。 */
export function createSessionControl(deps: SessionControlDeps): SessionControlApi {
  const executeTask = async (taskItem: CollaborateRequest["tasks"][number], sessionId: string, userId: CollaborateRequest["userId"], requestId: string, index: number): Promise<AgentExecuteResult> => {
    const executeRequest: ExecuteRequest = {
      task: taskItem.task,
      session_id: sessionId,
      userId,
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
    const results = request.mode === "parallel"
      ? await Promise.all(request.tasks.map((taskItem, index) => executeTask(taskItem, sessionId, request.userId, requestId, index)))
      : await runSequential(request, sessionId, request.userId, requestId, executeTask);
    return { results, session_id: sessionId, total_tasks: request.tasks.length };
  };

  return {
    async stopSession(sessionId) {
      const handle = deps.statusTracker.getRunningHandleBySession(sessionId);
      if (!handle) {
        const result = await deps.runtimeStorage.operations.interruptSession({
          sessionId,
        });
        await deps.pendingInteractions.cancelSession(sessionId, "suspended run cancelled");
        await deps.clientEvents.deliver(result.records.map((record) => record.outbox));
        return result.interruptedRuns.length > 0 || result.cancelledInteractions > 0;
      }
      // A live stop targets the attached foreground root. Background children
      // own a separate lease and therefore finish independently; when no
      // foreground handle remains, interruptSession closes every detached run.
      deps.eventPublisher.publishUserInterrupt(handle.status, "user_stop");
      const runId = handle.status.run_id;
      if (runId) deps.statusTracker.cancelRun(runId, "user_stop");
      else handle.abortController.abort(new Error("user_stop"));
      return true;
    },
    async collaborateSequentially(request, requestId) {
      return runCollaborate({ ...request, mode: "sequential" }, requestId);
    },
    collaborate: runCollaborate,
  };
}

async function runSequential(
  request: CollaborateRequest,
  sessionId: string,
  userId: CollaborateRequest["userId"],
  requestId: string,
  executeTask: (taskItem: CollaborateRequest["tasks"][number], sessionId: string, userId: CollaborateRequest["userId"], requestId: string, index: number) => Promise<AgentExecuteResult>,
): Promise<AgentExecuteResult[]> {
  const results: AgentExecuteResult[] = [];
  for (const [index, taskItem] of request.tasks.entries()) {
    const result = await executeTask(taskItem, sessionId, userId, requestId, index);
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
