import type { TenantId } from "../../identity/types.js";
import type { ApprovalCacheResolution, PendingInteractionPort } from "./pending-interactions.js";

export interface DaemonRuntime {
  pendingInteractions: PendingInteractionPort;
  conversationStore: {
    getSession(sessionId: string): { metadata: Record<string, unknown> } | null;
  };
  resumeExecutor: {
    resumeRun(input: {
      sessionId: string;
      approvalId: string;
      resolution: ApprovalCacheResolution;
      onCompleted?: (result: { content: string; success: boolean }) => void;
      onSuspended?: (approvalId: string) => void;
    }): unknown;
  };
}

/** Runtime lifecycle boundary used by daemon interaction callbacks. */
export interface DaemonRuntimeProvider {
  acquire(tenantId: TenantId): Promise<{ runtime: DaemonRuntime; release(): void }>;
}
