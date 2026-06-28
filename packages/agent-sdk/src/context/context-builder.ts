/**
 * AgentContextBuilder（设计稿 §7，迁自 backend-ts）。
 * 差异：microcompact TTL 从 systemConfig 改为构造期注入；删 agent 字段透传。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { MessageInfo } from "../types.js";
import type {
  AgentContext,
  AgentContextBuilderOptions,
  AgentContextRequest,
  AgentContextSource,
  ResolvedAgentContextRequest,
} from "./types.js";
import {
  DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS,
  DEFAULT_THREAD_KEY,
} from "./types.js";
import { positiveIntegerOrDefault, resolveMicrocompactTtlSeconds } from "./helpers.js";

export class AgentContextBuilder {
  private readonly microcompactTtlSeconds: number;

  constructor(
    private readonly sources: AgentContextSource[],
    options: AgentContextBuilderOptions = {},
  ) {
    this.microcompactTtlSeconds = resolveMicrocompactTtlSeconds(options.microcompactTtlSeconds);
  }

  buildContext(request: AgentContextRequest): AgentContext {
    const resolved = resolveContextRequest(request, this.microcompactTtlSeconds);
    const conversation: ChatMessage[] = [];
    const rawMessages: MessageInfo[] = [];
    const sourceMetadata: AgentContext["metadata"]["sources"] = [];
    for (const source of this.sources) {
      const contribution = source.build(resolved);
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
    return {
      conversation,
      rawMessages,
      metadata: {
        session_id: resolved.sessionId,
        thread_key: resolved.threadKey,
        stable_prefix_fingerprint: resolved.stablePrefixFingerprint ?? "no_stable_prefix",
        sources: sourceMetadata,
      },
    };
  }
}

function resolveContextRequest(
  request: AgentContextRequest,
  microcompactTtlSeconds: number,
): ResolvedAgentContextRequest {
  return {
    sessionId: request.sessionId,
    threadKey: request.threadKey?.trim() || DEFAULT_THREAD_KEY,
    microcompact: request.microcompact === true,
    microcompactKeepRecentTools: positiveIntegerOrDefault(
      request.microcompactKeepRecentTools,
      DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOLS,
    ),
    stablePrefixFingerprint: null,
    microcompactTtlSeconds,
  };
}
