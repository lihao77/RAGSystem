import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { MessageInfo, SessionInfo } from "../../../contracts/session.js";
import type { ChatMessage } from "../../integrations/llm-chat-client.js";

export interface ConversationHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[];
}

export interface SessionMetadataPort {
  getSession(sessionId: string): Pick<SessionInfo, "metadata"> | null;
  updateSessionMetadata?(sessionId: string, patch: Record<string, unknown>): Record<string, unknown> | null;
}

export interface SystemConfigPort {
  getConfig(): Record<string, unknown>;
}

export interface AgentContextRequest {
  sessionId: string;
  threadKey?: string | null;
  historyLimit?: number;
  agent?: AgentConfig | null;
  microcompact?: boolean;
  microcompactKeepRecentTools?: number;
  forceMemoryPrefixRefresh?: boolean;
}

export interface AgentContext {
  conversation: ChatMessage[];
  metadata: {
    session_id: string;
    thread_key: string;
    history_limit: number;
    stable_prefix_fingerprint: string | null;
    sources: Array<{
      name: string;
      message_count: number;
      metadata?: Record<string, unknown>;
    }>;
  };
}

export interface AgentContextContribution {
  conversation?: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface AgentContextSource {
  readonly name: string;
  build(request: ResolvedAgentContextRequest): AgentContextContribution;
}

export interface ResolvedAgentContextRequest {
  sessionId: string;
  threadKey: string;
  historyLimit: number;
  agent: AgentConfig | null;
  microcompact: boolean;
  microcompactKeepRecentTools: number;
  forceMemoryPrefixRefresh: boolean;
  stablePrefixFingerprint: string | null;
  microcompactTtlSeconds: number;
}

export const DEFAULT_HISTORY_LIMIT = 20;
export const DEFAULT_THREAD_KEY = "root";
export const DEFAULT_INDEX_MAX_LINES = 200;
export const DEFAULT_INDEX_MAX_CHARS = 25600;
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS = 5;
export const DEFAULT_MICROCOMPACT_TTL_SECONDS = 600;
export const MICROCOMPACT_CLEARED_LABEL = "[工具结果已清理]";

export interface AgentContextBuilderOptions {
  systemConfig?: SystemConfigPort | undefined;
}
