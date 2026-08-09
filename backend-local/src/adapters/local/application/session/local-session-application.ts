import type { PermissionMode } from "@ragsystem/backend-core/contracts/runtime/permissions.js";
import type { SessionApplication } from "@ragsystem/backend-core/contracts/session/session-application.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { AgentSessionApplication } from "@ragsystem/backend-core/services/sessions/index.js";
import type { ConversationStore } from "../../sqlite/conversation-store/index.js";
import { TenantSessionIdentityApplication } from "@ragsystem/backend-core/services/sessions/session-identity-application.js";
import { canonicalLocalWorkspaceKey, normalizeLocalWorkspacePath } from "@ragsystem/backend-core/services/workspaces/workspace-application.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SessionTeamSnapshotResolver } from "@ragsystem/backend-core/contracts/session/session.js";

/** Binds the Local session service to one request tenant. */
export class LocalSessionApplication implements SessionApplication {
  private readonly sessionIdentities: TenantSessionIdentityApplication;

  constructor(
    private readonly tenantId: TenantId,
    private readonly sessions: AgentSessionApplication,
    private readonly conversations: ConversationStore,
    private readonly teamSnapshots: SessionTeamSnapshotResolver,
  ) {
    this.sessionIdentities = new TenantSessionIdentityApplication(tenantId, {
      getSession: async (sessionId) => conversations.getSession(sessionId),
      createSession: async (input) => { await sessions.createSession(input); },
      updateSessionMetadata: async (sessionId, patch) => conversations.updateSessionMetadata(sessionId, patch),
    });
  }

  ensureSession(input: Parameters<SessionApplication["ensureSession"]>[0]) {
    return this.sessionIdentities.ensureSession(input);
  }

  async createSession(input: Parameters<SessionApplication["createSession"]>[0]) {
    const { teamName, entryAgentName, ...identity } = input;
    return this.sessions.createSession({
      ...identity,
      tenantId: this.tenantId,
      teamSnapshot: this.teamSnapshots.createTeamSnapshot({ teamName, entryAgentName }),
    });
  }
  async listSessions(input: Parameters<SessionApplication["listSessions"]>[0]) {
    return this.sessions.listSessions({ ...input, tenantId: this.tenantId });
  }
  async listSessionFacets(input: Parameters<SessionApplication["listSessionFacets"]>[0]) {
    return this.sessions.listSessionFacets({ ...input, tenantId: this.tenantId });
  }
  async listWorkspacesByIds(workspaceIds: readonly string[]) {
    return this.conversations.listWorkspacesByIds(this.tenantId, workspaceIds);
  }
  async listWorkspaces() {
    return this.conversations.listAllWorkspaces(this.tenantId);
  }
  async removeWorkspace(workspaceId: string) {
    return this.conversations.removeWorkspace(this.tenantId, workspaceId);
  }
  async resolveWorkspace(input: { kind: "local_path"; root_path: string } | { kind: "existing"; workspace_id: string } | null | undefined): Promise<string | null> {
    if (!input) return null;
    if (input.kind === "existing") {
      const existing = this.conversations.getWorkspaceById(this.tenantId, input.workspace_id);
      if (!existing || existing.removed_at) throw new Error("Workspace 不存在或已移除");
      return existing.workspace_id;
    }
    const rootPath = await normalizeLocalWorkspacePath(input.root_path);
    const resolved = this.conversations.resolveLocalWorkspace({
      workspaceId: randomUUID(), tenantId: this.tenantId, kind: "local",
      displayName: path.basename(rootPath) || rootPath, rootPath,
      canonicalKey: canonicalLocalWorkspaceKey(rootPath),
    });
    return resolved.workspace_id;
  }
  async getSession(sessionId: string) { return this.sessions.getSession(sessionId); }
  async resolveWorkspaceRoot(sessionId: string): Promise<string | null> {
    const session = await this.getSession(sessionId);
    if (!session?.workspace_id) return null;
    return this.conversations.getWorkspaceById(this.tenantId, session.workspace_id)?.root_path ?? null;
  }
  async getSessionForExecutionValidation(sessionId: string) { return this.sessions.getSession(sessionId); }
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>) { return this.sessionIdentities.updateSessionMetadata(sessionId, patch); }
  async updateSessionPermissionMode(sessionId: string, mode: PermissionMode) { return this.conversations.updateSessionPermissionMode(sessionId, mode); }
  async deleteSession(sessionId: string) { return this.sessions.deleteSession(sessionId); }
  async listMessages(input: Parameters<SessionApplication["listMessages"]>[0]) { return this.sessions.listMessages(input); }
  async getRecentMessages(sessionId: string, limit = 10_000, threadKey?: string | null) {
    return this.conversations.getRecentMessages(sessionId, limit, threadKey ?? "root");
  }
  async getMessageForRetry(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }) {
    return input.afterSeq != null
      ? this.conversations.getMessageBySeq(input.sessionId, input.afterSeq)
      : input.afterMessageId ? this.conversations.getMessageById(input.sessionId, input.afterMessageId) : null;
  }
  async listMessageRunSteps(input: Parameters<SessionApplication["listMessageRunSteps"]>[0]) { return this.sessions.listMessageRunSteps(input); }
  async listParticipantRuns(input: Parameters<SessionApplication["listParticipantRuns"]>[0]) { return this.sessions.listParticipantRuns(input); }
  async listParticipantRunExecutionSteps(input: Parameters<SessionApplication["listParticipantRunExecutionSteps"]>[0]) { return this.sessions.listParticipantRunExecutionSteps(input); }
  async updateUserMessage(input: Parameters<SessionApplication["updateUserMessage"]>[0]) { return this.sessions.updateUserMessage(input); }
  async rollbackMessages(input: Parameters<SessionApplication["rollbackMessages"]>[0]) { return this.sessions.rollbackMessages(input); }
  async exportSession(sessionId: string) { return this.sessions.exportSession(sessionId); }
}
