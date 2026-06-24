/**
 * 上下文管理类型（设计稿 §7，迁自 backend-ts context-builder/types.ts）。
 *
 * 差异：删 AgentContextRequest.agent（context-builder 全程不读 agent，纯透传，无价值）；
 * microcompact TTL 从 systemConfig 改为构造期注入（SDK 不查 systemConfig）。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { MessageInfo } from "../types.js";

/** 历史读取端口（SDK 内置 store 实现此接口）。 */
export interface ConversationHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[];
}

/** 会话元数据读写端口（microcompact 缓存指纹用；SDK 内置 store 或 dispatcher 装配侧实现）。 */
export interface SessionMetadataPort {
  getSession(sessionId: string): { metadata: Record<string, unknown> } | null;
  updateSessionMetadata?(sessionId: string, patch: Record<string, unknown>): Record<string, unknown> | null;
}

export interface AgentContextRequest {
  sessionId: string;
  threadKey?: string | null;
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
  microcompact: boolean;
  microcompactKeepRecentTools: number;
  forceMemoryPrefixRefresh: boolean;
  stablePrefixFingerprint: string | null;
  microcompactTtlSeconds: number;
}

export const HISTORY_SCAN_LIMIT = 10_000;
export const DEFAULT_THREAD_KEY = "root";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS = 5;
export const DEFAULT_MICROCOMPACT_TTL_SECONDS = 600;
export const MICROCOMPACT_CLEARED_LABEL = "[工具结果已清理]";

/** builder 构造期注入（microcompact TTL 从这取，不查 systemConfig）。 */
export interface AgentContextBuilderOptions {
  microcompactTtlSeconds?: number;
}
