import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import type {
  AgentContext,
  AgentContextBuilderOptions,
  AgentContextRequest,
  AgentContextSource,
  ResolvedAgentContextRequest,
} from "./types.js";
import {
  DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS,
  DEFAULT_MICROCOMPACT_TTL_SECONDS,
  DEFAULT_THREAD_KEY,
} from "./types.js";
import { positiveIntegerOrDefault, resolveMicrocompactTtlSeconds } from "./helpers.js";

export * from "./types.js";
export { isStableSystemContextContent } from "./helpers.js";
export {
  filterHistoryMessages,
  resolveCompressionView,
  resolveHistoryView,
} from "./history-view.js";
export { RecentMessagesContextSource } from "./recent-messages-source.js";
export { EmptyMemoryContextSource } from "./empty-memory-source.js";
export { MemoryIndexContextSource } from "./memory-index-source.js";

export class AgentContextBuilder {
  constructor(
    private readonly sources: AgentContextSource[],
    private readonly options: AgentContextBuilderOptions = {},
  ) {}

  buildContext(request: AgentContextRequest): AgentContext {
    const resolved = resolveContextRequest(request);
    resolved.microcompactTtlSeconds = resolveMicrocompactTtlSeconds(this.options.systemConfig?.getConfig());
    const conversation: ChatMessage[] = [];
    const sourceMetadata: AgentContext["metadata"]["sources"] = [];
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
        stable_prefix_fingerprint: resolved.stablePrefixFingerprint ?? "no_stable_prefix",
        sources: sourceMetadata,
      },
    };
  }
}

function resolveContextRequest(request: AgentContextRequest): ResolvedAgentContextRequest {
  return {
    sessionId: request.sessionId,
    threadKey: request.threadKey?.trim() || DEFAULT_THREAD_KEY,
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
