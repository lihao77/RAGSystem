import type { PermissionMode } from "../../contracts/permissions.js";
import type { SessionApplication } from "../../contracts/session-application.js";
import type { TenantId } from "../../identity/types.js";
import type { AgentSessionApplication } from "../../services/sessions/index.js";
import type { ConversationStore } from "../../services/stores/conversation-store/index.js";

/** Binds the synchronous Local session service to one request tenant. */
export class LocalSessionApplication implements SessionApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly sessions: AgentSessionApplication,
    private readonly conversations: ConversationStore,
  ) {}

  createSession(input: Parameters<SessionApplication["createSession"]>[0]) {
    return this.sessions.createSession({ ...input, tenantId: this.tenantId });
  }
  listSessions(input: Parameters<SessionApplication["listSessions"]>[0]) {
    return this.sessions.listSessions({ ...input, tenantId: this.tenantId });
  }
  getSession(sessionId: string) { return this.sessions.getSession(sessionId); }
  getSessionForExecutionValidation(sessionId: string) { return this.sessions.getSession(sessionId); }
  updateSessionPermissionMode(sessionId: string, mode: PermissionMode) { return this.conversations.updateSessionPermissionMode(sessionId, mode); }
  deleteSession(sessionId: string) { return this.sessions.deleteSession(sessionId); }
  listMessages(input: Parameters<SessionApplication["listMessages"]>[0]) { return this.sessions.listMessages(input); }
  getRecentMessages(sessionId: string, limit = 10_000, threadKey?: string | null) {
    return this.conversations.getRecentMessages(sessionId, limit, threadKey ?? "root");
  }
  listMessageRunSteps(input: Parameters<SessionApplication["listMessageRunSteps"]>[0]) { return this.sessions.listMessageRunSteps(input); }
  updateUserMessage(input: Parameters<SessionApplication["updateUserMessage"]>[0]) { return this.sessions.updateUserMessage(input); }
  rollbackMessages(input: Parameters<SessionApplication["rollbackMessages"]>[0]) { return this.sessions.rollbackMessages(input); }
  exportSession(sessionId: string) { return this.sessions.exportSession(sessionId); }
}
