import type { PermissionMode } from "../../../../contracts/runtime/permissions.js";
import type { ListMemoryCandidatesInput } from "../../../../contracts/conversation-store/index.js";
import type { SessionApplication } from "../../../../contracts/session/session-application.js";
import type { TenantId } from "../../../../identity/types.js";
import type { AgentSessionApplication } from "../../../../services/sessions/index.js";
import type { ConversationStore } from "../../sqlite/conversation-store/index.js";
import { TenantDaemonSessionApplication } from "../../../../services/sessions/daemon-session-application.js";

/** Binds the Local session service to one request tenant. */
export class LocalSessionApplication implements SessionApplication {
  private readonly daemonSessions: TenantDaemonSessionApplication;

  constructor(
    private readonly tenantId: TenantId,
    private readonly sessions: AgentSessionApplication,
    private readonly conversations: ConversationStore,
  ) {
    this.daemonSessions = new TenantDaemonSessionApplication(tenantId, {
      getSession: async (sessionId) => conversations.getSession(sessionId),
      createSession: async (input) => { await sessions.createSession(input); },
      updateSessionMetadata: async (sessionId, patch) => conversations.updateSessionMetadata(sessionId, patch),
    });
  }

  ensureSession(input: Parameters<SessionApplication["ensureSession"]>[0]) {
    return this.daemonSessions.ensureSession(input);
  }

  async createSession(input: Parameters<SessionApplication["createSession"]>[0]) {
    return this.sessions.createSession({ ...input, tenantId: this.tenantId });
  }
  async listSessions(input: Parameters<SessionApplication["listSessions"]>[0]) {
    return this.sessions.listSessions({ ...input, tenantId: this.tenantId });
  }
  async getSession(sessionId: string) { return this.sessions.getSession(sessionId); }
  async getSessionForExecutionValidation(sessionId: string) { return this.sessions.getSession(sessionId); }
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>) { return this.daemonSessions.updateSessionMetadata(sessionId, patch); }
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
  async listMemoryCandidates(input: ListMemoryCandidatesInput) {
    return this.conversations.listMemoryCandidates(input);
  }
  async listMessageRunSteps(input: Parameters<SessionApplication["listMessageRunSteps"]>[0]) { return this.sessions.listMessageRunSteps(input); }
  async updateUserMessage(input: Parameters<SessionApplication["updateUserMessage"]>[0]) { return this.sessions.updateUserMessage(input); }
  async rollbackMessages(input: Parameters<SessionApplication["rollbackMessages"]>[0]) { return this.sessions.rollbackMessages(input); }
  async exportSession(sessionId: string) { return this.sessions.exportSession(sessionId); }
}
