import type { AsyncConversationRepository, AsyncPendingInteractionStore, AsyncRunStore } from "../../contracts/async-persistence-ports.js";
import type { TenantId } from "../../identity/types.js";
import type { SuspendedSessionControlPort } from "../../contracts/runtime-async-ports.js";

export interface InterruptedSuspendedRun {
  runId: string;
  parentRunId: string | null;
}

export type AsyncSuspendedSessionControl = SuspendedSessionControlPort;

/** Tenant-bound cancellation boundary for durable executions without a live process handle. */
export class SaaSSessionControlApplication implements AsyncSuspendedSessionControl {
  constructor(
    private readonly tenantId: TenantId,
    private readonly conversations: Pick<AsyncConversationRepository, "getSession">,
    private readonly runs: Pick<AsyncRunStore, "interruptSuspendedRuns">,
    private readonly pending: Pick<AsyncPendingInteractionStore, "cancelPendingInteractions">,
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
