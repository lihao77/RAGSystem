/**
 * RecentMessagesContextSource(自 SDK context/recent-messages-source.ts 迁入)。
 * 从 conversationStore 读历史 → filterHistoryMessages → 压缩视图 → microcompact 裁剪 → conversation。
 *
 * 字段适配:history-view 已改 snake;本 source 不直接访问 MessageInfo 字段(全经 history-view 纯函数)。
 */
import type {
  AgentContextContribution,
  AgentContextSource,
  ConversationHistoryPort,
  ResolvedAgentContextRequest,
} from "./types.js";
import { HISTORY_SCAN_LIMIT } from "./types.js";
import fs from "node:fs";
import {
  countObservationMessages,
  filterHistoryMessages,
  messagesToConversation,
  microcompactHistoryMessages,
  resolveCompressionViewDetailed,
} from "./history-view.js";
import { projectConversationExtensions, type ProjectionRegistry } from "./extensions/index.js";
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { MessageInfo } from "../../../contracts/session/session.js";
import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";

export class RecentMessagesContextSource implements AgentContextSource {
  readonly name = "recent_messages";

  constructor(
    private readonly history: ConversationHistoryPort,
    private readonly supportsVision: boolean = false,
    private readonly extensionRegistry: ProjectionRegistry,
    private readonly attachmentFiles: SessionFileLookupPort | null = null,
  ) {}

  async build(request: ResolvedAgentContextRequest): Promise<AgentContextContribution> {
    const messages = await this.history.getRecentMessages(request.sessionId, HISTORY_SCAN_LIMIT, request.threadKey);
    const filteredMessages = filterHistoryMessages(messages);
    const compressionView = resolveCompressionViewDetailed(filteredMessages);
    const historyMessages = compressionView.messages;
    const microcompactApplied = request.microcompact && !request.cacheAlive;
    const microcompact = microcompactApplied
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
        applied: microcompactApplied,
        reason: request.cacheAlive ? "cache_fresh" : "cache_expired",
        keep_recent_tools: request.microcompactKeepRecentTools,
        observation_count: microcompact.observationCount,
        cleared_count: microcompact.clearedCount,
      };
    }
    const { conversation, originals } = messagesToConversation(microcompact.messages);
    await restoreActiveProviderContinuation(request.sessionId, conversation, originals, this.history);
    // extensions 投影(组装层,压缩视图之后):user 附件/UI 上下文 + tool 结果媒体。
    // 附件图片可缓存；tool 图片每次读盘以遵守 transient TTL。两者都不把图片字节写入 SQLite。
    const attachmentCache = new Map<string, Promise<{ body: Uint8Array; contentType: string | null } | null>>();
    await projectConversationExtensions(conversation, originals, this.extensionRegistry, {
      sessionId: request.sessionId,
      supportsVision: this.supportsVision,
      readAttachment: (sessionId, fileId) => this.readAttachment(sessionId, fileId, attachmentCache),
      readToolImage,
    });
    return { conversation, rawMessages: originals, metadata };
  }

  private readAttachment(
    sessionId: string,
    fileId: string,
    cache: Map<string, Promise<{ body: Uint8Array; contentType: string | null } | null>>,
  ): Promise<{ body: Uint8Array; contentType: string | null } | null> {
    if (!this.attachmentFiles) return Promise.resolve(null);
    const key = `${sessionId}\0${fileId}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = this.attachmentFiles.read(sessionId, fileId).catch(() => null);
    cache.set(key, pending);
    return pending;
  }
}

async function restoreActiveProviderContinuation(
  sessionId: string,
  conversation: ChatMessage[],
  originals: (MessageInfo | null)[],
  history: ConversationHistoryPort,
): Promise<void> {
  if (!history.getProviderContinuation) return;
  // A continuation is active only when the last non-tool message is its assistant tool call.
  // A later user or assistant message starts a new transaction and must not inherit hidden state.
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (!message || message.role === "tool") continue;
    if (message.role !== "assistant" || !message.tool_calls?.length) return;
    const original = originals[index];
    if (!original) return;
    const record = await history.getProviderContinuation(sessionId, original.id);
    if (!record) return;
    const expected = new Set(message.tool_calls.map((call) => call.id));
    if (record.state.toolCallIds.length !== expected.size || !record.state.toolCallIds.every((id) => expected.has(id))) return;
    message.provider_continuation = record.state;
    return;
  }
}

/** Tool media obeys transient TTL, so it must never reuse the attachment data-URL cache. */
function readToolImage(storedPath: string, mime: string): string | null {
  try {
    const buf = fs.readFileSync(storedPath);
    return `data:${mime || "image/png"};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}
