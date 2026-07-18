/**
 * context 组装端口与类型。
 *
 * 自 SDK context/types.ts 迁入(去 SDK 数据库依赖的一环):recent 组装归 backend,
 * memory source 亦 implements 这些端口。MessageInfo 用 backend contracts/session(snake)。
 */
import type { ChatMessage, ProviderContinuationState } from "@ragsystem/agent-llm";
import type { MessageInfo } from "../../../contracts/session.js";

/** 历史读取端口(委托 conversationStore.listMessages)。 */
export interface ConversationHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[] | Promise<MessageInfo[]>;
  /** Private lookup; omitted by read-only projections that must not expose provider state. */
  getProviderContinuation?(sessionId: string, messageId: string): { state: ProviderContinuationState } | null;
}

/** 会话元数据读写端口(conversationStore 装配侧实现)。 */
export interface SessionMetadataPort {
  getSession(sessionId: string): { metadata: Record<string, unknown>; user_id?: string | null } | null;
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
   * 与 conversation 逐条对齐的 rawMessage(补占位 tool message 无 rawMessage → null)。
   * 只 recent 类 source 贡献;调试快照(monitoring)据此按 index 回绑 seq/msg_type 等元数据。
   */
  rawMessages: (MessageInfo | null)[];
  metadata: {
    session_id: string;
    thread_key: string;
    sources: Array<{
      name: string;
      message_count: number;
      metadata?: Record<string, unknown>;
    }>;
  };
}

export interface AgentContextContribution {
  conversation?: ChatMessage[];
  /** 与 conversation 逐条对齐的 rawMessage(补占位处为 null);供调试快照按 index 回绑元数据。 */
  rawMessages?: (MessageInfo | null)[];
  metadata?: Record<string, unknown>;
}

export interface AgentContextSource {
  readonly name: string;
  build(request: ResolvedAgentContextRequest): Promise<AgentContextContribution>;
}

export interface ResolvedAgentContextRequest {
  sessionId: string;
  threadKey: string;
  microcompact: boolean;
  microcompactKeepRecentTools: number;
  /** provider KV cache 是否还活(buildContext 据 ProviderCacheTracker 设)。source 据此决定是否更新:cache 活→冻结(命中/保持完整);cache 死→更新(重建/清理)。 */
  cacheAlive: boolean;
  /** 本次 build 是否续期 last_used_at(滑动续期)。只在真正发请求的 run 路径 true;只读 build(preview/token 预算)false,不产生写副作用。 */
  touch: boolean;
}

export const HISTORY_SCAN_LIMIT = 10_000;
export const DEFAULT_THREAD_KEY = "root";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS = 5;
export const MICROCOMPACT_CLEARED_LABEL = "[工具结果已清理]";
