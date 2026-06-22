import type {
  AgentContextContribution,
  AgentContextSource,
  ResolvedAgentContextRequest,
  ConversationHistoryPort,
  SessionMetadataPort,
} from "./types.js";
import { HISTORY_SCAN_LIMIT } from "./types.js";
import { getString, isSessionMetadataPort, readPipelineCache } from "./helpers.js";
import {
  countObservationMessages,
  filterHistoryMessages,
  messagesToConversation,
  microcompactHistoryMessages,
  resolveCompressionViewDetailed,
} from "./history-view.js";

export class RecentMessagesContextSource implements AgentContextSource {
  readonly name = "recent_messages";
  private readonly sessions: SessionMetadataPort | null;

  constructor(private readonly history: ConversationHistoryPort) {
    this.sessions = isSessionMetadataPort(history) ? history : null;
  }

  build(request: ResolvedAgentContextRequest): AgentContextContribution {
    const messages = this.history.getRecentMessages(request.sessionId, HISTORY_SCAN_LIMIT, request.threadKey);
    const filteredMessages = filterHistoryMessages(messages);
    const compressionView = resolveCompressionViewDetailed(filteredMessages);
    const historyMessages = compressionView.messages;
    const microcompactDecision = request.microcompact
      ? this.resolveMicrocompactDecision(request)
      : { requested: false, applied: false, reason: "disabled" };
    const microcompact = microcompactDecision.applied
      ? microcompactHistoryMessages(historyMessages, request.microcompactKeepRecentTools)
      : {
          messages: historyMessages,
          clearedCount: 0,
          observationCount: countObservationMessages(historyMessages),
        };
    const metadata: Record<string, unknown> = {
      source_message_count: messages.length,
      filtered_message_count: filteredMessages.length,
      resolved_message_count: microcompact.messages.length,
      compression_view: {
        applied: compressionView.applied,
        summary_seq: compressionView.summarySeq,
        replaces_up_to_seq: compressionView.replacesUpToSeq,
      },
    };
    if (request.microcompact) {
      metadata.microcompact = {
        applied: microcompactDecision.applied,
        reason: microcompactDecision.reason,
        keep_recent_tools: request.microcompactKeepRecentTools,
        observation_count: microcompact.observationCount,
        cleared_count: microcompact.clearedCount,
        ttl_seconds: request.microcompactTtlSeconds,
      };
    }
    return {
      conversation: messagesToConversation(microcompact.messages),
      metadata,
    };
  }

  private resolveMicrocompactDecision(request: ResolvedAgentContextRequest): {
    requested: boolean;
    applied: boolean;
    reason: string;
  } {
    const metadata = this.sessions?.getSession(request.sessionId)?.metadata ?? {};
    const cache = readPipelineCache(metadata, request.threadKey);
    const currentFingerprint = request.stablePrefixFingerprint ?? "no_stable_prefix";
    const previousFingerprint = getString(cache.fp);
    const lastPreparedAt = typeof cache.t === "number" && Number.isFinite(cache.t) ? cache.t : null;
    const nowSeconds = Date.now() / 1000;
    let applied = false;
    let reason = "cache_fresh";
    if (previousFingerprint !== currentFingerprint) {
      applied = true;
      reason = "fingerprint_changed";
    } else if (lastPreparedAt === null) {
      applied = true;
      reason = "missing_cache_time";
    } else if (nowSeconds - lastPreparedAt >= request.microcompactTtlSeconds) {
      applied = true;
      reason = "ttl_expired";
    }

    return { requested: true, applied, reason };
  }
}
