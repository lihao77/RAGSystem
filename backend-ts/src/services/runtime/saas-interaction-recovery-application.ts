import type {
  PendingInteractionRecord,
  ProviderContinuationRecord,
} from "../../contracts/conversation-store/index.js";
import type { PostgresConversationRepository } from "../../adapters/saas/postgres/conversation-repository.js";
import type { PostgresPendingInteractionRepository } from "../../adapters/saas/postgres/pending-interaction-repository.js";
import type { PostgresProviderContinuationRepository } from "../../adapters/saas/postgres/provider-continuation-repository.js";
import type { TenantId } from "../../identity/types.js";
import type {
  InteractionRecoveryApplication,
  InteractionRecoveryResult,
} from "../../contracts/interaction-recovery-application.js";

/** Tenant-bound recovery facade for interactions that outlive the Local runtime process. */
export class SaaSInteractionRecoveryApplication implements InteractionRecoveryApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly conversations: Pick<PostgresConversationRepository, "getSession">,
    private readonly pending: Pick<
      PostgresPendingInteractionRepository,
      "getPendingInteraction" | "listPendingInteractions" | "updatePendingInteractionStatus"
    >,
    private readonly continuations: Pick<PostgresProviderContinuationRepository, "getProviderContinuation">,
  ) {}

  async respondApproval(
    sessionId: string,
    interactionId: string,
    resolution: { approved: boolean; message: string },
  ): Promise<InteractionRecoveryResult> {
    return this.respond(sessionId, interactionId, "approval", resolution);
  }

  async respondUserInput(
    sessionId: string,
    interactionId: string,
    resolution: { value: string },
  ): Promise<InteractionRecoveryResult> {
    return this.respond(sessionId, interactionId, "user_input", resolution);
  }

  async getProviderContinuation(
    sessionId: string,
    messageId: string,
  ): Promise<ProviderContinuationRecord | null> {
    if (!(await this.ownsSession(sessionId))) return null;
    return this.continuations.getProviderContinuation(this.tenantId, sessionId, messageId);
  }

  private async respond(
    sessionId: string,
    interactionId: string,
    kind: "approval" | "user_input",
    resolution: Record<string, unknown>,
  ): Promise<InteractionRecoveryResult> {
    if (!(await this.ownsSession(sessionId))) return missing(kind, interactionId);
    const record = await this.pending.getPendingInteraction(sessionId, interactionId);
    if (!record || record.kind !== kind || record.status === "cancelled") return missing(kind, interactionId);
    if (record.status === "resuming" || record.status === "consumed") {
      return result(record, false);
    }
    if (record.status === "resolved") {
      return result(record, await this.isBatchReady(record));
    }
    const wasSuspended = record.status === "suspended";
    const updated = await this.pending.updatePendingInteractionStatus({
      sessionId,
      interactionId,
      from: ["waiting", "suspended"],
      status: "resolved",
      resolution,
    });
    if (!updated) {
      const current = await this.pending.getPendingInteraction(sessionId, interactionId);
      return current && current.kind === kind && current.status !== "cancelled"
        ? result(current, current.status === "resolved" && await this.isBatchReady(current))
        : missing(kind, interactionId);
    }
    return result(record, wasSuspended && await this.isBatchReady(record));
  }

  private async isBatchReady(record: PendingInteractionRecord): Promise<boolean> {
    const unresolved = await this.pending.listPendingInteractions({
      sessionId: record.session_id,
      batchId: record.batch_id,
      statuses: ["waiting", "suspended"],
    });
    return unresolved.length === 0;
  }

  private async ownsSession(sessionId: string): Promise<boolean> {
    const session = await this.conversations.getSession(sessionId);
    return session?.tenant_id === this.tenantId;
  }
}

function missing(kind: "approval" | "user_input", interactionId: string): InteractionRecoveryResult {
  return { resolved: false, needsResume: false, kind, interactionId };
}

function result(record: PendingInteractionRecord, needsResume: boolean): InteractionRecoveryResult {
  return {
    resolved: true,
    needsResume,
    kind: record.kind,
    interactionId: record.interaction_id,
    rootRunId: record.root_run_id,
    toolCallId: record.tool_call_id,
  };
}
