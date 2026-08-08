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
