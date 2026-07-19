import type { AsyncConversationRepository, AsyncPendingInteractionStore } from "../../../contracts/storage/async-persistence-ports.js";
import type { PermissionMode } from "../../../contracts/permissions.js";
import type { TenantId, UserId } from "../../../identity/types.js";
import type { DaemonSuspendedInteraction } from "../../../services/daemon/daemon-service.js";

/** Tenant-safe async state boundary used by daemon execution in SaaS mode. */
export class SaaSDaemonState {
  constructor(
    private readonly conversations: Pick<
      AsyncConversationRepository,
      "createSession" | "getSession" | "updateSessionMetadata"
    >,
    private readonly pending: Pick<AsyncPendingInteractionStore, "listPendingInteractions">,
  ) {}

  async ensureSession(input: {
    tenantId: TenantId;
    sessionId: string;
    botId: UserId;
    metadata?: Record<string, unknown>;
    permissionMode: PermissionMode;
  }): Promise<void> {
    const existing = await this.conversations.getSession(input.sessionId);
    if (existing && existing.tenant_id !== input.tenantId) {
      throw new Error(`daemon session belongs to another tenant: ${input.sessionId}`);
    }
    await this.conversations.createSession(
      input.tenantId,
      input.sessionId,
      input.botId,
      input.metadata ?? {},
      input.permissionMode,
    );
  }

  async updateMetadata(tenantId: TenantId, sessionId: string, patch: Record<string, unknown>): Promise<void> {
    await this.requireOwnedSession(tenantId, sessionId);
    await this.conversations.updateSessionMetadata(sessionId, patch);
  }

  async listSuspendedInteractions(input: {
    tenantId: TenantId;
    sessionId: string;
    rootRunId: string;
    botId: UserId;
  }): Promise<DaemonSuspendedInteraction[]> {
    await this.requireOwnedSession(input.tenantId, input.sessionId);
    const records = await this.pending.listPendingInteractions({
      sessionId: input.sessionId,
      rootRunId: input.rootRunId,
      statuses: ["waiting", "suspended"],
    });
    return records.map((record) => {
      const payload = record.request_payload;
      return {
        approvalId: record.interaction_id,
        sessionId: record.session_id,
        botId: input.botId,
        rootRunId: record.root_run_id,
        kind: record.kind,
        ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
        ...(typeof payload.riskLevel === "string" ? { riskLevel: payload.riskLevel } : {}),
        ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
        ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
        ...(Array.isArray(payload.options)
          ? { options: payload.options.filter((item): item is string => typeof item === "string") }
          : {}),
      };
    });
  }

  private async requireOwnedSession(tenantId: TenantId, sessionId: string): Promise<void> {
    const session = await this.conversations.getSession(sessionId);
    if (!session || session.tenant_id !== tenantId) {
      throw new Error(`daemon session not found for tenant: ${sessionId}`);
    }
  }
}
