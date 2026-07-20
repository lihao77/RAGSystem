import type { AsyncConversationRepository } from "../../../contracts/storage/async-persistence-ports.js";
import type { PermissionMode } from "../../../contracts/runtime/permissions.js";
import type { TenantId, UserId } from "../../../identity/types.js";

/** Tenant-safe async state boundary used by daemon execution in SaaS mode. */
export class SaaSDaemonState {
  constructor(
    private readonly conversations: Pick<
      AsyncConversationRepository,
      "createSession" | "getSession" | "updateSessionMetadata"
    >,
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

  private async requireOwnedSession(tenantId: TenantId, sessionId: string): Promise<void> {
    const session = await this.conversations.getSession(sessionId);
    if (!session || session.tenant_id !== tenantId) {
      throw new Error(`daemon session not found for tenant: ${sessionId}`);
    }
  }
}
