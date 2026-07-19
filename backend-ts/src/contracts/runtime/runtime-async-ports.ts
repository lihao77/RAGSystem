import type { MessageInfo, SessionInfo } from "../session/session.js";
import type { ProviderContinuationRecord } from "../conversation-store/index.js";
import type { TenantId } from "../../identity/types.js";

export interface AsyncConversationHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  getSession(sessionId: string): Promise<SessionInfo | null>;
  updateSessionMetadata(sessionId: string, patch: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  insertCompressionMessage(input: {
    sessionId: string;
    summaryContent: string;
    replacesUpToSeq?: number | null;
    threadKey?: string;
    childAgentId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<MessageInfo>;
}

export interface AsyncProviderContinuationLookupPort {
  getProviderContinuation(tenantId: TenantId, sessionId: string, messageId: string): Promise<ProviderContinuationRecord | null>;
}

export interface SuspendedSessionControlPort {
  interruptSuspendedSession(sessionId: string): Promise<Array<{ runId: string; parentRunId: string | null }>>;
}
