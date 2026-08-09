import { normalizeSessionMetadata, normalizeSessionTeamSnapshot, type CreateSessionRecordInput, type SessionIdentity, type SessionInfo } from "../../contracts/session/session.js";
import { assertSafeSessionId } from "../../contracts/session/session-id.js";
import type { TenantId } from "../../identity/types.js";

export interface SessionIdentityStoragePort {
  getSession(sessionId: string): Promise<SessionInfo | null>;
  createSession(input: CreateSessionRecordInput): Promise<void>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}

/** Shared tenant-owned session lifecycle used by externally initiated runs. */
export class TenantSessionIdentityApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly storage: SessionIdentityStoragePort,
  ) {}

  async ensureSession(input: SessionIdentity): Promise<void> {
    assertSafeSessionId(input.sessionId);
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    const teamSnapshot = normalizeSessionTeamSnapshot(input.teamSnapshot);
    const existing = await this.storage.getSession(input.sessionId);
    if (existing && existing.tenant_id !== this.tenantId) {
      throw new Error(`session belongs to another tenant: ${input.sessionId}`);
    }
    if (!existing) {
      await this.storage.createSession({
        tenantId: this.tenantId,
        sessionId: input.sessionId,
        ownerUserId: input.ownerUserId,
        visibility: input.visibility,
        originType: input.originType,
        originId: input.originId,
        originChannel: input.originChannel,
        workspaceId: input.workspaceId,
        teamSnapshot,
        metadata,
        permissionMode: input.permissionMode ?? null,
      });
      return;
    }
    if (existing.owner_user_id !== input.ownerUserId
      || existing.visibility !== input.visibility
      || existing.origin_type !== input.originType
      || existing.origin_id !== input.originId
      || existing.origin_channel !== input.originChannel
      || existing.workspace_id !== input.workspaceId
      || existing.team_snapshot.team_name !== teamSnapshot.team_name
      || existing.team_snapshot.team_revision !== teamSnapshot.team_revision
      || existing.team_snapshot.entry_agent_name !== teamSnapshot.entry_agent_name) {
      throw new Error(`session immutable identity mismatch: ${input.sessionId}`);
    }
    if (Object.keys(metadata).length > 0) {
      await this.requireMetadataUpdate(input.sessionId, metadata);
    }
  }

  async updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.storage.getSession(sessionId);
    if (!existing || existing.tenant_id !== this.tenantId) {
      throw new Error(`session not found for tenant: ${sessionId}`);
    }
    return this.requireMetadataUpdate(sessionId, normalizeSessionMetadata(patch));
  }

  private async requireMetadataUpdate(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const metadata = await this.storage.updateSessionMetadata(sessionId, patch);
    if (!metadata) throw new Error(`session not found for tenant: ${sessionId}`);
    return metadata;
  }
}
