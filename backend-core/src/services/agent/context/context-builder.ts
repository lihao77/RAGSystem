/**
 * AgentContextBuilder(自 SDK context/context-builder.ts 迁入)。
 * 遍历 sources(memory + recent),拼接 contribution → AgentContext。
 *
 * ProviderCacheTracker(可选)统一管 provider cache 活性(按 threadKey 分桶):buildContext 开始据
 * isAlive 设 request.cacheAlive(驱动各 source 是否更新——cache 活则冻结、cache 死则重建/清理),结束
 * (if touch)续期 last_used_at。source 层只读 request.cacheAlive,不自管时间戳。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { MessageInfo } from "../../../contracts/session/session.js";
import type {
  AgentContext,
  AgentContextRequest,
  AgentContextSource,
  ResolvedAgentContextRequest,
} from "./types.js";
import { DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS, DEFAULT_THREAD_KEY } from "./types.js";
import { positiveIntegerOrDefault } from "./helpers.js";
import type { ProviderCacheTracker } from "./provider-cache-tracker.js";

export class AgentContextBuilder {
  constructor(
    private readonly sources: AgentContextSource[],
    private readonly cacheTracker?: ProviderCacheTracker,
  ) {}

  async buildContext(request: AgentContextRequest, options?: { touch?: boolean }): Promise<AgentContext> {
    const touch = options?.touch ?? true;
    const now = Date.now() / 1000;
    const threadKey = request.threadKey?.trim() || DEFAULT_THREAD_KEY;
    const cacheAlive = this.cacheTracker?.isAlive(request.sessionId, threadKey, now) ?? false;
    const resolved = resolveContextRequest(request, threadKey, touch, cacheAlive);
    const conversation: ChatMessage[] = [];
    const rawMessages: (MessageInfo | null)[] = [];
    const sourceMetadata: AgentContext["metadata"]["sources"] = [];
    for (const source of this.sources) {
      const contribution = await source.build(resolved);
      const messages = contribution.conversation ?? [];
      conversation.push(...messages);
      if (contribution.rawMessages) {
        rawMessages.push(...contribution.rawMessages);
      }
      sourceMetadata.push({
        name: source.name,
        message_count: messages.length,
        ...(contribution.metadata ? { metadata: contribution.metadata } : {}),
      });
    }
    // 续期 last_used_at(滑动,按 threadKey 分桶):只在真正发请求的 run 路径(touch=true);只读 build 不续期。
    if (touch && this.cacheTracker) {
      this.cacheTracker.touch(request.sessionId, threadKey, now);
    }
    return {
      conversation,
      rawMessages,
      metadata: {
        session_id: resolved.sessionId,
        thread_key: resolved.threadKey,
        sources: sourceMetadata,
      },
    };
  }
}

function resolveContextRequest(
  request: AgentContextRequest,
  threadKey: string,
  touch: boolean,
  cacheAlive: boolean,
): ResolvedAgentContextRequest {
  return {
    sessionId: request.sessionId,
    threadKey,
    microcompact: request.microcompact === true,
    microcompactKeepRecentTools: positiveIntegerOrDefault(
      request.microcompactKeepRecentTools,
      DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS,
    ),
    cacheAlive,
    touch,
  };
}
