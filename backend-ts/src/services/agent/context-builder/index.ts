import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import type {
  AgentRuntimeContext,
  AgentRuntimeContextBuilderOptions,
  AgentRuntimeContextRequest,
  AgentRuntimeContextSource,
  ResolvedAgentRuntimeContextRequest,
} from "./types.js";
import {
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS,
  DEFAULT_MICROCOMPACT_TTL_SECONDS,
  DEFAULT_THREAD_KEY,
} from "./types.js";
import { positiveIntegerOrDefault, resolveMicrocompactTtlSeconds } from "./helpers.js";

export * from "./types.js";
export { isRuntimeStableSystemContextContent } from "./helpers.js";
export {
  filterRuntimeHistoryMessages,
  resolveCompressionView,
  resolveRuntimeHistoryView,
} from "./history-view.js";
export { RecentMessagesContextSource } from "./recent-messages-source.js";
export { EmptyMemoryContextSource } from "./empty-memory-source.js";
export { MemoryIndexContextSource } from "./memory-index-source.js";

export class AgentRuntimeContextBuilder {
  constructor(
    private readonly sources: AgentRuntimeContextSource[],
    private readonly options: AgentRuntimeContextBuilderOptions = {},
  ) {}

  buildContext(request: AgentRuntimeContextRequest): AgentRuntimeContext {
    const resolved = resolveContextRequest(request);
    resolved.microcompactTtlSeconds = resolveMicrocompactTtlSeconds(this.options.systemConfig?.getConfig());
    const conversation: ChatMessage[] = [];
    const sourceMetadata: AgentRuntimeContext["metadata"]["sources"] = [];
    for (const source of this.sources) {
      const contribution = source.build(resolved);
      const messages = contribution.conversation ?? [];
      conversation.push(...messages);
      sourceMetadata.push({
        name: source.name,
        message_count: messages.length,
        ...(contribution.metadata ? { metadata: contribution.metadata } : {}),
      });
    }
    return {
      conversation,
      metadata: {
        session_id: resolved.sessionId,
        thread_key: resolved.threadKey,
        history_limit: resolved.historyLimit,
        stable_prefix_fingerprint: resolved.stablePrefixFingerprint ?? "no_stable_prefix",
        sources: sourceMetadata,
      },
    };
  }
}

function resolveContextRequest(request: AgentRuntimeContextRequest): ResolvedAgentRuntimeContextRequest {
  return {
    sessionId: request.sessionId,
    threadKey: request.threadKey?.trim() || DEFAULT_THREAD_KEY,
    historyLimit: request.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    agent: request.agent ?? null,
    microcompact: request.microcompact === true,
    microcompactKeepRecentTools: positiveIntegerOrDefault(
      request.microcompactKeepRecentTools,
      DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS,
    ),
    forceMemoryPrefixRefresh: request.forceMemoryPrefixRefresh === true,
    stablePrefixFingerprint: null,
    microcompactTtlSeconds: DEFAULT_MICROCOMPACT_TTL_SECONDS,
  };
}
