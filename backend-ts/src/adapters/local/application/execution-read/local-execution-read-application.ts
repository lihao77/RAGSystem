import type { ConversationStore } from "../../../../contracts/conversation-store/index.js";
import type { ExecutionReadApplication } from "../../../../contracts/execution/execution-read-application.js";
import type { AgentExecutionServiceApi } from "../../../../services/agent/execution/index.js";

type LocalExecutionReader = Pick<AgentExecutionServiceApi,
  "getSessionTaskStatus" | "getSessionExecutionDiagnostics" | "getTaskStatus" |
  "getTaskExecutionDiagnostics" | "listRunningTasks" | "getOverview">;

/** Local adapter over the in-process execution tracker and persisted overview. */
export class LocalExecutionReadApplication implements ExecutionReadApplication {
  constructor(
    private readonly execution: LocalExecutionReader,
    private readonly conversations: Pick<ConversationStore,
      "getPersistedExecutionOverview" | "getSession" | "listRuns" | "listOutboxForReplay">,
  ) {}

  async getSession(sessionId: string) { return this.conversations.getSession(sessionId); }
  async listRuns(sessionId: string, limit = 500) { return this.conversations.listRuns(sessionId, limit).items; }
  async listOutboxForReplay(input: { sessionId: string; runIds?: readonly string[]; afterSeq?: number | null; limit?: number }) {
    return this.conversations.listOutboxForReplay({
      sessionId: input.sessionId,
      ...(input.runIds ? { runIds: input.runIds } : {}),
      ...(input.afterSeq !== null && input.afterSeq !== undefined ? { afterSeq: input.afterSeq } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  }
  async getSessionTaskStatus(sessionId: string) { return this.execution.getSessionTaskStatus(sessionId); }
  async getSessionExecutionDiagnostics(sessionId: string) { return this.execution.getSessionExecutionDiagnostics(sessionId); }
  async getTaskStatus(taskId: string) { return this.execution.getTaskStatus(taskId); }
  async getTaskExecutionDiagnostics(taskId: string) { return this.execution.getTaskExecutionDiagnostics(taskId); }
  async listRunningTasks() { return this.execution.listRunningTasks(); }
  async getOverview(activeOnly: boolean) {
    const live = this.execution.getOverview(activeOnly);
    return live.count > 0 ? live : this.conversations.getPersistedExecutionOverview(activeOnly);
  }
}
