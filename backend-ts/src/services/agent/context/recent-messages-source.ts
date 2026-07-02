/**
 * RecentMessagesContextSource(自 SDK context/recent-messages-source.ts 迁入)。
 * 从 conversationStore 读历史 → filterHistoryMessages → 压缩视图 → microcompact 裁剪 → conversation。
 *
 * 字段适配:history-view 已改 snake;本 source 不直接访问 MessageInfo 字段(全经 history-view 纯函数)。
 * history 端口由消费端(runtime-adapter)装配时委托 conversationStore;若同时实现 SessionMetadataPort,
 * microcompact fingerprint 缓存读取生效。
 */
import type {
  AgentContextContribution,
  AgentContextSource,
  ConversationHistoryPort,
  ResolvedAgentContextRequest,
  SessionMetadataPort,
} from "./types.js";
import { HISTORY_SCAN_LIMIT } from "./types.js";
import { getString, isSessionMetadataPort, readPipelineCache } from "./helpers.js";
import fs from "node:fs";
import {
  countObservationMessages,
  filterHistoryMessages,
  messagesToConversation,
  microcompactHistoryMessages,
  resolveCompressionViewDetailed,
} from "./history-view.js";
import { enrichConversationImages } from "./attachment-image.js";

export class RecentMessagesContextSource implements AgentContextSource {
  readonly name = "recent_messages";
  private readonly sessions: SessionMetadataPort | null;

  constructor(private readonly history: ConversationHistoryPort, private readonly supportsVision: boolean = false) {
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
      : { messages: historyMessages, clearedCount: 0, observationCount: countObservationMessages(historyMessages) };
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
    const conversation = messagesToConversation(microcompact.messages);
    // 图片注入(组装层,压缩视图之后):user 消息的 image 附件读盘转 base64 注入 content。
    enrichConversationImages(conversation, microcompact.messages, readAttachmentImage, this.supportsVision);
    return { conversation, rawMessages: microcompact.messages, metadata };
  }

  private resolveMicrocompactDecision(
    request: ResolvedAgentContextRequest,
  ): { requested: boolean; applied: boolean; reason: string } {
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

/** 附件图片 base64 缓存(storedPath → dataUrl;空串为读盘失败标记,避免重复读失败)。图片文件内容不变,多轮对话复用。 */
const attachmentImageCache = new Map<string, string>();

/** 读附件图片为 base64 data URL;读盘失败返回 null(由 enrichConversationImages 降级为文本占位)。结果缓存。 */
function readAttachmentImage(storedPath: string, mime: string): string | null {
  if (attachmentImageCache.has(storedPath)) {
    const cached = attachmentImageCache.get(storedPath);
    return cached === "" ? null : cached ?? null;
  }
  try {
    const buf = fs.readFileSync(storedPath);
    const url = `data:${mime || "image/png"};base64,${buf.toString("base64")}`;
    attachmentImageCache.set(storedPath, url);
    return url;
  } catch {
    attachmentImageCache.set(storedPath, "");
    return null;
  }
}
