import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { InteractionCoordinator } from "@ragsystem/backend-core/contracts/runtime/pending-interactions.js";

export interface DaemonRuntime {
  interactionCoordinator: Pick<InteractionCoordinator, "respondApprovalAsync" | "respondUserInputAsync" | "listPendingAsync" | "peekApprovalMeta">;
  sessionApplication: {
    getSession(sessionId: string): Promise<{ metadata: Record<string, unknown> } | null>;
  };
}

/** Runtime lifecycle boundary used by daemon interaction callbacks. */
export interface DaemonRuntimeProvider {
  acquire(tenantId: TenantId): Promise<{ runtime: DaemonRuntime; release(): void }>;
}
