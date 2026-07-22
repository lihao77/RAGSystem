import type { ConversationStore } from "./sqlite/conversation-store/index.js";
import type {
  AgentSessionMessageInput,
  AgentSessionMessageUpdate,
  AgentSessionRepositoryPort,
} from "../../contracts/session/agent-session-repository.js";
import type { TenantId } from "../../identity/types.js";
import type { PermissionMode } from "../../contracts/runtime/permissions.js";

/** Adapts the synchronous SQLite conversation facade to the shared async port. */
export class LocalAgentSessionRepository implements AgentSessionRepositoryPort {
  constructor(private readonly store: ConversationStore) {}

  async createSession(
    tenantId: TenantId,
    sessionId: string,
    userId: string | null,
    metadata: Record<string, unknown>,
    permissionMode: PermissionMode | null,
  ) {
    this.store.createSession(tenantId, sessionId, userId, metadata, permissionMode);
  }

  async getSession(sessionId: string) { return this.store.getSession(sessionId); }
  async updateSessionMetadata(sessionId: string, patch: Record<string, unknown>) {
    return this.store.updateSessionMetadata(sessionId, patch);
  }
  async deleteSession(sessionId: string) { return this.store.deleteSession(sessionId); }
  async listSessions(tenantId: TenantId, limit: number, offset: number, userIds: readonly string[] | null) {
    return this.store.listSessions(tenantId, limit, offset, userIds);
  }

  async addMessage(input: AgentSessionMessageInput) { return this.store.addMessage(input); }
  async listMessages(sessionId: string, limit: number, offset: number) {
    return this.store.listMessages(sessionId, limit, offset);
  }
  async getMessageBySeq(sessionId: string, seq: number) { return this.store.getMessageBySeq(sessionId, seq); }
  async getMessageById(sessionId: string, messageId: string) { return this.store.getMessageById(sessionId, messageId); }
  async getFirstMessageAfterSeq(sessionId: string, seq: number) {
    return this.store.getFirstMessageAfterSeq(sessionId, seq);
  }
  async listMessagesAfterSeq(sessionId: string, seq: number, limit: number) {
    return this.store.listMessagesAfterSeq(sessionId, seq, limit);
  }
  async listMessagesBeforeOrAtSeq(sessionId: string, seq: number, limit: number) {
    return this.store.listMessagesBeforeOrAtSeq(sessionId, seq, limit);
  }
  async deleteMessagesAfter(
    sessionId: string,
    input: { afterSeq?: number | null; afterMessageId?: string | null },
  ) {
    return this.store.deleteMessagesAfter(sessionId, input);
  }
  async updateMessage(input: AgentSessionMessageUpdate) { return this.store.updateMessage(input); }

  async listRuns(sessionId: string, limit: number) { return this.store.listRuns(sessionId, limit); }
  async listRunSteps(input: {
    runId?: string | null;
    messageId?: string | null;
    sessionId?: string | null;
    limit?: number;
  }) {
    return this.store.listRunSteps(input);
  }
}
