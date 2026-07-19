import type { PostgresConversationRepository } from "../../adapters/saas/postgres/conversation-repository.js";
import type { PostgresPendingInteractionRepository } from "../../adapters/saas/postgres/pending-interaction-repository.js";
import type { PostgresRunRepository } from "../../adapters/saas/postgres/run-repository.js";
import type { TenantId } from "../../identity/types.js";

export interface InterruptedSuspendedRun {
  runId: string;
  parentRunId: string | null;
}

export interface AsyncSuspendedSessionControl {
  interruptSuspendedSession(sessionId: string): Promise<InterruptedSuspendedRun[]>;
}

/** Tenant-bound cancellation boundary for durable executions without a live process handle. */
export class SaaSSessionControlApplication implements AsyncSuspendedSessionControl {
  constructor(
    private readonly tenantId: TenantId,
    private readonly conversations: Pick<PostgresConversationRepository, "getSession">,
    private readonly runs: Pick<PostgresRunRepository, "interruptSuspendedRuns">,
    private readonly pending: Pick<PostgresPendingInteractionRepository, "cancelPendingInteractions">,
  ) {}

  async interruptSuspendedSession(sessionId: string): Promise<InterruptedSuspendedRun[]> {
    const session = await this.conversations.getSession(sessionId);
    if (session?.tenant_id !== this.tenantId) return [];

    const interrupted = await this.runs.interruptSuspendedRuns(this.tenantId, sessionId);
    if (interrupted.length === 0) return [];
    await this.pending.cancelPendingInteractions(sessionId);
    return interrupted.map((item) => ({ runId: item.run_id, parentRunId: item.parent_run_id }));
  }
}
