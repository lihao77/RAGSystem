import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { MessageInfo, SessionInfo } from "../../../contracts/session.js";
import type { ChatMessage } from "@ragsystem/agent-llm";

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
  agent: AgentConfig | null;
  microcompact: boolean;
  microcompactKeepRecentTools: number;
  forceMemoryPrefixRefresh: boolean;
  stablePrefixFingerprint: string | null;
  microcompactTtlSeconds: number;
}

/**
 * DB 查询技术安全阀（SQL LIMIT 防野），非上下文裁剪语义。
 * 上下文预算由 token 压缩体系（microcompact 廉价裁剪 + 85% 阈值 LLM 摘要）统一管理——
 * 取历史不做条数截断，全量读出交由压缩按 token 裁。值对齐压缩模块 DEFAULT_HISTORY_SCAN_LIMIT。
 */
export const HISTORY_SCAN_LIMIT = 10_000;
export const DEFAULT_THREAD_KEY = "root";
export const DEFAULT_INDEX_MAX_LINES = 200;
export const DEFAULT_INDEX_MAX_CHARS = 25600;
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS = 5;
export const DEFAULT_MICROCOMPACT_TTL_SECONDS = 600;
export const MICROCOMPACT_CLEARED_LABEL = "[工具结果已清理]";

export interface AgentContextBuilderOptions {
  systemConfig?: SystemConfigPort | undefined;
}
