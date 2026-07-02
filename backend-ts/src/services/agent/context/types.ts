/**
 * context 组装端口与类型。
 *
 * 自 SDK context/types.ts 迁入(去 SDK 数据库依赖的一环):recent 组装归 backend,
 * memory source 亦 implements 这些端口。MessageInfo 用 backend contracts/session(snake)。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { MessageInfo } from "../../../contracts/session.js";

/** 历史读取端口(委托 conversationStore.listMessages)。 */
export interface ConversationHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[];
}

/** 会话元数据读写端口(microcompact 缓存指纹用;conversationStore 装配侧实现)。 */
export interface SessionMetadataPort {
  getSession(sessionId: string): { metadata: Record<string, unknown> } | null;
  updateSessionMetadata?(sessionId: string, patch: Record<string, unknown>): Record<string, unknown> | null;
}

export interface AgentContextRequest {
  sessionId: string;
  threadKey?: string | null;
  microcompact?: boolean;
  microcompactKeepRecentTools?: number;
}

export interface AgentContext {
  conversation: ChatMessage[];
  /**
   * 原始历史消息(含 seq/metadata),与 conversation 的历史段一一对应。
   * 只 recent 类 source 贡献;调试快照(monitoring preview)据此展示消息元数据。
   */
  rawMessages: MessageInfo[];
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
  /** 原始历史消息(含 seq/metadata),与 conversation 一一对应;供调试快照展示元数据。 */
  rawMessages?: MessageInfo[];
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
  stablePrefixFingerprint: string | null;
  microcompactTtlSeconds: number;
}

export const HISTORY_SCAN_LIMIT = 10_000;
export const DEFAULT_THREAD_KEY = "root";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS = 5;
export const DEFAULT_MICROCOMPACT_TTL_SECONDS = 600;
export const MICROCOMPACT_CLEARED_LABEL = "[工具结果已清理]";

/** builder 构造期注入(microcompact TTL 从 systemConfig 算好传入)。 */
export interface AgentContextBuilderOptions {
  microcompactTtlSeconds?: number;
}
