import type { OutboxRow, RunInfo } from "../../contracts/conversation-store/index.js";
import type { ExecutionTaskStatus, SessionTaskStatus } from "../../contracts/execution.js";
import type { SessionInfo } from "../../contracts/session.js";
import type { PostgresConversationRepository } from "../../adapters/saas/postgres/conversation-repository.js";
import type { PostgresOutboxRepository } from "../../adapters/saas/postgres/outbox-repository.js";
import type { PostgresRunRepository } from "../../adapters/saas/postgres/run-repository.js";

/** Tenant-bound read facade used while the Agent execution path is still being made fully asynchronous. */
export class SaaSAgentReadApplication {
  constructor(
    private readonly tenantId: string,
    private readonly conversations: Pick<PostgresConversationRepository, "getSession">,
    private readonly runs: Pick<PostgresRunRepository, "listRuns">,
    private readonly outbox: Pick<PostgresOutboxRepository, "listOutboxForReplay">,
  ) {}

  async getSession(sessionId: string): Promise<SessionInfo | null> {
    const session = await this.conversations.getSession(sessionId);
    return session?.tenant_id === this.tenantId ? session : null;
  }

  async getSessionTaskStatus(sessionId: string): Promise<SessionTaskStatus> {
    if (!(await this.getSession(sessionId))) return idleStatus(sessionId);
    const latest = (await this.runs.listRuns(this.tenantId, sessionId, 500)).items[0] ?? null;
    if (!latest) return idleStatus(sessionId);
    const task = toTaskStatus(latest);
    return {
      session_id: sessionId,
      has_running_task: latest.status === "running",
      has_active_system_command: false,
      task_info: task,
      observability: null,
      diagnostics: null,
    };
  }

  async listRuns(sessionId: string, limit = 500): Promise<RunInfo[]> {
    if (!(await this.getSession(sessionId))) return [];
    return (await this.runs.listRuns(this.tenantId, sessionId, limit)).items;
  }

  async listOutboxForReplay(input: { sessionId: string; runIds?: readonly string[]; afterSeq?: number; limit?: number }): Promise<OutboxRow[]> {
    if (!(await this.getSession(input.sessionId))) return [];
    return this.outbox.listOutboxForReplay({ tenantId: this.tenantId, ...input });
  }
}

function idleStatus(sessionId: string): SessionTaskStatus {
  return { session_id: sessionId, has_running_task: false, has_active_system_command: false, task_info: null, observability: null, diagnostics: null };
}

function toTaskStatus(run: RunInfo): ExecutionTaskStatus {
  const running = run.status === "running";
  return {
    task_id: run.run_id,
    session_id: run.session_id,
    run_id: run.run_id,
    request_id: run.request_id,
    execution_kind: run.entrypoint ?? "execute",
    task: run.task_summary ?? "",
    status: run.status,
    elapsed_seconds: null,
    started_at: run.created_at,
    finished_at: running ? null : run.updated_at,
    thread_alive: running,
  };
}
