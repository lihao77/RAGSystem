import type { PermissionMode } from "../../contracts/runtime/permissions.js";
import { normalizeSessionMetadata, type SessionInfo } from "../../contracts/session/session.js";
import { assertSafeSessionId } from "../../contracts/session/session-id.js";
import type { TenantId } from "../../identity/types.js";

export interface DaemonSessionStoragePort {
  getSession(sessionId: string): Promise<SessionInfo | null>;
  createSession(input: {
    tenantId: TenantId;
    sessionId: string;
    userId: string;
    metadata: Record<string, unknown>;
    permissionMode: PermissionMode | null;
  }): Promise<void>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

/** Shared tenant-owned session lifecycle used by daemon-triggered runs. */
export class TenantDaemonSessionApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly storage: DaemonSessionStoragePort,
  ) {}

  async ensureSession(input: {
    sessionId: string;
    userId: string;
    metadata?: Record<string, unknown>;
    permissionMode?: PermissionMode | null;
  }): Promise<void> {
    assertSafeSessionId(input.sessionId);
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    const existing = await this.storage.getSession(input.sessionId);
    if (existing && existing.tenant_id !== this.tenantId) {
      throw new Error(`daemon session belongs to another tenant: ${input.sessionId}`);
    }
    if (!existing) {
      await this.storage.createSession({
        tenantId: this.tenantId,
        sessionId: input.sessionId,
        userId: input.userId,
        metadata,
        permissionMode: input.permissionMode ?? null,
      });
      return;
    }
    if (Object.keys(metadata).length > 0) {
      await this.requireMetadataUpdate(input.sessionId, metadata);
    }
  }

  async updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.storage.getSession(sessionId);
    if (!existing || existing.tenant_id !== this.tenantId) {
      throw new Error(`daemon session not found for tenant: ${sessionId}`);
    }
    return this.requireMetadataUpdate(sessionId, normalizeSessionMetadata(patch));
  }

  private async requireMetadataUpdate(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const metadata = await this.storage.updateSessionMetadata(sessionId, patch);
    if (!metadata) throw new Error(`daemon session not found for tenant: ${sessionId}`);
    return metadata;
  }
}
