import type { ConversationStore } from "../../sqlite/conversation-store/index.js";
import type { ExecutionReadApplication } from "../../../../contracts/execution/execution-read-application.js";
import type { AgentExecutionServiceApi } from "../../../../services/agent/execution/index.js";
import { ExecutionReadProjector } from "../../../../services/agent/execution/execution-read-projector.js";

type LocalExecutionReader = Pick<AgentExecutionServiceApi,
  "getSessionTaskStatus" | "getSessionExecutionDiagnostics" | "getTaskStatus" |
  "getTaskExecutionDiagnostics" | "listRunningTasks" | "getOverview">;

/** Local adapter over the in-process execution tracker and persisted overview. */
export class LocalExecutionReadApplication implements ExecutionReadApplication {
  private readonly projector: ExecutionReadProjector;
  constructor(
    private readonly execution: LocalExecutionReader,
    private readonly conversations: Pick<ConversationStore,
      "getPersistedExecutionOverview" | "getSession" | "listRuns" | "listOutboxForReplay">,
  ) {
    this.projector = new ExecutionReadProjector(execution, {
      getSession: async (sessionId) => conversations.getSession(sessionId),
      listRuns: async (sessionId, limit) => conversations.listRuns(sessionId, limit).items,
      listOutboxForReplay: async (input) => conversations.listOutboxForReplay({
        sessionId: input.sessionId,
        ...(input.runIds ? { runIds: input.runIds } : {}),
        ...(input.afterSeq != null ? { afterSeq: input.afterSeq } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
      listRunsForOverview: async (activeOnly) => {
        const overview = conversations.getPersistedExecutionOverview(activeOnly);
        return overview.items.map((item) => ({
          run_id: item.run_id!, session_id: item.session_id!, tenant_id: "local", entrypoint: item.execution_kind,
          status: item.status, task_summary: item.task, request_id: item.request_id, user_id: null, agent_name: null,
          thread_key: "root", parent_run_id: null, parent_call_id: null, child_agent_id: null, final_message_id: null,
          created_at: item.started_at ?? "", updated_at: item.finished_at ?? item.started_at ?? "",
        }));
      },
      getPersistedOverview: async (activeOnly) => conversations.getPersistedExecutionOverview(activeOnly),
    });
  }

  getSession(sessionId: string) { return this.projector.getSession(sessionId); }
  listRuns(sessionId: string, limit = 500) { return this.projector.listRuns(sessionId, limit); }
  listOutboxForReplay(input: Parameters<ExecutionReadProjector["listOutboxForReplay"]>[0]) { return this.projector.listOutboxForReplay(input); }
  getSessionTaskStatus(sessionId: string) { return this.projector.getSessionTaskStatus(sessionId); }
  getSessionExecutionDiagnostics(sessionId: string) { return this.projector.getSessionExecutionDiagnostics(sessionId); }
  getTaskStatus(taskId: string) { return this.projector.getTaskStatus(taskId); }
  getTaskExecutionDiagnostics(taskId: string) { return this.projector.getTaskExecutionDiagnostics(taskId); }
  listRunningTasks() { return this.projector.listRunningTasks(); }
  getOverview(activeOnly: boolean) { return this.projector.getOverview(activeOnly); }
}
