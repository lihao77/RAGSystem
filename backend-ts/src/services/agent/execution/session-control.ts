import type {
  AgentExecuteResult,
  CollaborateRequest,
  ExecuteRequest,
} from "../../../contracts/execution.js";
import type { AgentExecutionEventPublisher } from "./event-publisher.js";
import type { AgentExecutionStatusTracker } from "./status-tracker.js";
import type { IRunStore } from "../../../contracts/conversation-store/index.js";
import type { PendingInteractionPort } from "../../../contracts/pending-interactions.js";
import type { AsyncDurableClientEventPublisher } from "../../runtime/event-outbox/async-client-event-publisher.js";
import type { AsyncSuspendedSessionControl } from "../../runtime/saas-session-control-application.js";

export interface SessionControlApi {
  stopSession(sessionId: string): Promise<boolean>;
  collaborateSequentially(
    request: CollaborateRequest,
    requestId: string,
  ): Promise<{ results: AgentExecuteResult[]; session_id: string; total_tasks: number }>;
}

export interface SessionControlDeps {
  statusTracker: AgentExecutionStatusTracker;
  eventPublisher: AgentExecutionEventPublisher;
  conversationStore: IRunStore;
  pendingInteractions: PendingInteractionPort;
  asyncSuspendedSessionControl?: AsyncSuspendedSessionControl;
  asyncClientEvents?: Pick<AsyncDurableClientEventPublisher, "publish">;
  /** collaborateSequentially 顺序复用 executeSynchronously（由 launchers 提供，注入打破环）。 */
  executeSynchronously: (request: ExecuteRequest, requestId: string) => Promise<AgentExecuteResult>;
}

/** stopSession 中断 + collaborateSequentially 顺序多任务（复用 executeSynchronously）。 */
export function createSessionControl(deps: SessionControlDeps): SessionControlApi {
  return {
    async stopSession(sessionId) {
      const handle = deps.statusTracker.getRunningHandleBySession(sessionId);
      if (!handle) {
        if (deps.asyncSuspendedSessionControl) {
          const interruptedRuns = await deps.asyncSuspendedSessionControl.interruptSuspendedSession(sessionId);
          if (interruptedRuns.length === 0) return false;
          deps.pendingInteractions.cancelSession(sessionId, "suspended run cancelled", { persist: false });
          await Promise.all(interruptedRuns
            .filter((run) => !run.parentRunId)
            .map((run) => deps.asyncClientEvents?.publish(sessionId, {
              type: "run_ended",
              session_id: sessionId,
              run_id: run.runId,
              payload: { status: "interrupted" },
            }, { runId: run.runId, aggregateType: "run", aggregateId: run.runId })));
          return true;
        }
        const suspendedRuns = deps.conversationStore.listRuns(sessionId, 1000).items
          .filter((run) => run.status === "suspended");
        if (suspendedRuns.length === 0) return false;
        deps.pendingInteractions.cancelSession(sessionId, "suspended run cancelled");
        for (const run of suspendedRuns) {
          deps.conversationStore.updateRunStatus(run.run_id, sessionId, "interrupted", null);
          if (!run.parent_run_id) deps.eventPublisher.publishRunEnded(sessionId, run.run_id, "interrupted");
        }
        return true;
      }
      deps.eventPublisher.publishUserInterrupt(handle.status, "user_stop");
      handle.abortController.abort();
      return true;
    },
    async collaborateSequentially(request, requestId) {
      const sessionId = request.session_id?.trim() || cryptoRandom();
      const results: AgentExecuteResult[] = [];
      for (const [index, taskItem] of request.tasks.entries()) {
        const executeRequest: ExecuteRequest = {
          task: taskItem.task,
          session_id: sessionId,
          userId: request.userId,
        };
        if (taskItem.agent !== undefined) {
          executeRequest.agent = taskItem.agent;
        }
        const result = await deps.executeSynchronously(executeRequest, `${requestId}:${index + 1}`);
        results.push(result);
        if (!result.success) {
          break;
        }
      }
      return {
        results,
        session_id: sessionId,
        total_tasks: request.tasks.length,
      };
    },
  };
}

function cryptoRandom(): string {
  return crypto.randomUUID();
}
