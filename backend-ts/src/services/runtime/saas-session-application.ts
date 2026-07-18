import type { PaginatedResult } from "../../contracts/common.js";
import type { AsyncConversationRepository } from "../../adapters/saas/postgres/conversation-repository.js";
import type { TenantId } from "../../identity/types.js";
import type { PermissionMode } from "../../contracts/permissions.js";
import type { MessageInfo, SessionInfo, SessionListItem } from "../../contracts/session.js";
import { normalizeSessionMetadata } from "../../contracts/session.js";
import { assertSafeSessionId } from "../../contracts/session-id.js";
import type { AsyncFileHistoryStore } from "../../contracts/file-history-store/index.js";

export class SaaSSessionApplication {
  constructor(
    private readonly tenantId: TenantId,
    private readonly repository: AsyncConversationRepository,
    private readonly fileHistory: AsyncFileHistoryStore | null = null,
  ) {}
  async createSession(input: { sessionId: string; userId: string; metadata?: Record<string, unknown>; permissionMode?: PermissionMode | null }) {
    assertSafeSessionId(input.sessionId);
    const metadata = normalizeSessionMetadata(input.metadata ?? {});
    await this.repository.createSession(this.tenantId, input.sessionId, input.userId, metadata, input.permissionMode ?? null);
    return { session_id: input.sessionId, user_id: input.userId, permission_mode: input.permissionMode ?? null, metadata };
  }
  listSessions(input: { limit?: number; offset?: number; userIds?: readonly string[] | null }): Promise<PaginatedResult<SessionListItem>> {
    return this.repository.listSessions(this.tenantId, input.limit ?? 20, input.offset ?? 0, input.userIds ?? null);
  }
  async getSession(sessionId: string): Promise<SessionInfo | null> { const row = await this.repository.getSession(sessionId); return row?.tenant_id === this.tenantId ? row : null; }
  /** Returns the raw row so route ownership validation can reject a cross-tenant session id. */
  getSessionForExecutionValidation(sessionId: string): Promise<SessionInfo | null> { return this.repository.getSession(sessionId); }
  async updateSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> { return (await this.getSession(sessionId)) ? this.repository.updateSessionPermissionMode(sessionId, mode) : false; }
  async deleteSession(sessionId: string): Promise<boolean> {
    if (!(await this.getSession(sessionId))) return false;
    await this.fileHistory?.cleanup(sessionId);
    return this.repository.deleteSession(sessionId);
  }
  async listMessages(input: { sessionId: string; limit?: number; offset?: number }): Promise<PaginatedResult<MessageInfo> | null> { if (!(await this.getSession(input.sessionId))) return null; return this.repository.listMessages(input.sessionId, input.limit ?? 20, input.offset ?? 0); }
  async updateUserMessage(input: { sessionId: string; messageId: string; content: string }): Promise<boolean> { if (!(await this.getSession(input.sessionId))) return false; return this.repository.updateMessage({ sessionId: input.sessionId, messageId: input.messageId, content: input.content, roleFilter: "user" }); }
  async rollbackMessages(input: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null }): Promise<number> {
    if (!(await this.getSession(input.sessionId))) return 0;
    const fileHistory = this.fileHistory;
    if (fileHistory) {
      let targetSeq = input.afterSeq ?? null;
      if (targetSeq == null && input.afterMessageId) {
        targetSeq = (await this.repository.getMessageById(input.sessionId, input.afterMessageId))?.seq ?? null;
      }
      if (targetSeq != null && await fileHistory.hasSnapshots(input.sessionId)) {
        await fileHistory.rewind(input.sessionId, targetSeq);
      }
    }
    return this.repository.deleteMessagesAfter(input.sessionId, {
      afterSeq: input.afterSeq ?? null,
      afterMessageId: input.afterMessageId ?? null,
    });
  }
}
