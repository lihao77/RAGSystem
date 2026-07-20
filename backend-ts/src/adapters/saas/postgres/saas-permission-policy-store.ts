import type { PermissionMode } from "../../../contracts/runtime/permissions.js";
import type { PermissionPolicyStorePort } from "../../../contracts/runtime/core-runtime-ports.js";
import type { AsyncConversationRepository } from "../../../contracts/storage/async-persistence-ports.js";
import type { TenantId } from "../../../identity/types.js";

/**
 * Tenant-bound permission snapshot. PostgreSQL is read asynchronously once per
 * run; the SDK gate then reads only this in-memory snapshot synchronously.
 */
export class SaaSPermissionPolicyStore implements PermissionPolicyStorePort {
  private readonly snapshots = new Map<string, PermissionMode | null>();

  constructor(
    private readonly tenantId: TenantId,
    private readonly sessions: Pick<AsyncConversationRepository, "getSession">,
  ) {}

  async prepareSession(sessionId: string): Promise<void> {
    const session = await this.sessions.getSession(sessionId);
    this.snapshots.set(
      sessionId,
      session?.tenant_id === this.tenantId ? session.permission_mode : null,
    );
  }

  getSession(sessionId: string): { permission_mode: PermissionMode | null } | null {
    if (!this.snapshots.has(sessionId)) {
      throw new Error(`permission snapshot is not prepared for session ${sessionId}`);
    }
    const permissionMode = this.snapshots.get(sessionId) ?? null;
    return { permission_mode: permissionMode };
  }
}
