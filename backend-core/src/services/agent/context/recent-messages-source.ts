/**
 * RecentMessagesContextSource(自 SDK context/recent-messages-source.ts 迁入)。
 * 从 conversationStore 读历史 → filterHistoryMessages → 压缩视图 → conversation。
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
  filterHistoryMessages,
  messagesToConversation,
  resolveCompressionViewDetailed,
} from "./history-view.js";
import { projectConversationExtensions, type ProjectionRegistry } from "./extensions/index.js";
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { MessageInfo } from "../../../contracts/session/session.js";
import type { MessageProviderState } from "../../../contracts/conversation-store/types.js";
import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";
import { projectCanonicalMessageContent } from "./message-content-projector.js";

export class RecentMessagesContextSource implements AgentContextSource {
  readonly name = "recent_messages";

  constructor(
    private readonly history: ConversationHistoryPort,
    private readonly supportsVision: boolean = false,
    private readonly extensionRegistry: ProjectionRegistry,
    private readonly attachmentFiles: SessionFileLookupPort | null = null,
    private readonly providerIdentity: { providerKey: string; model: string } | null = null,
  ) {}

  async build(request: ResolvedAgentContextRequest): Promise<AgentContextContribution> {
    const messages = await this.history.getRecentMessages(request.sessionId, HISTORY_SCAN_LIMIT, request.threadKey);
    const filteredMessages = filterHistoryMessages(messages);
    const compressionView = resolveCompressionViewDetailed(filteredMessages);
    const historyMessages = compressionView.messages;
    const metadata: Record<string, unknown> = {
      source_message_count: messages.length,
      filtered_message_count: filteredMessages.length,
      resolved_message_count: historyMessages.length,
      compression_view: {
        applied: compressionView.applied,
        summary_seq: compressionView.summarySeq,
        replaces_up_to_seq: compressionView.replacesUpToSeq,
      },
    };
    const { conversation, originals } = messagesToConversation(historyMessages);
    restoreActiveProviderContinuation(conversation, originals, this.providerIdentity);
    // Canonical message content first, then metadata-only context extensions.
    // 附件图片可缓存；tool 图片每次读盘以遵守 transient TTL。两者都不把图片字节写入 SQLite。
    const attachmentCache = new Map<string, Promise<{ body: Uint8Array; contentType: string | null } | null>>();
    await projectCanonicalMessageContent(conversation, originals, {
      sessionId: request.sessionId,
      supportsVision: this.supportsVision,
      readAttachment: (sessionId, fileId) => this.readAttachment(sessionId, fileId, attachmentCache),
    });
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

/**
 * 恢复未关闭工具事务的隐藏推理状态（消息行内 provider_state）。
 * 门控三连，任一不满足即不挂载：
 * 1. 事务开放：最后的非 tool 消息必须是 assistant 工具调用（后续 user/assistant 消息开启新事务，不得继承隐藏状态）；
 * 2. 印章匹配：provider_key + model 与本次 run 一致（签名是签发模型专属的加密证明，跨模型回放会被拒或静默计费）；
 * 3. 逐轮恢复：事务内每条 assistant 工具调用轮都挂载（厂商要求整段事务的隐藏推理一起回传）。
 */
function restoreActiveProviderContinuation(
  conversation: ChatMessage[],
  originals: (MessageInfo | null)[],
  providerIdentity: { providerKey: string; model: string } | null,
): void {
  if (!providerIdentity) return;
  const matchesStamp = (state: MessageProviderState): boolean =>
    state.provider_key === providerIdentity.providerKey && state.model === providerIdentity.model;

  // 事务开放判定：从末尾跳过 tool 消息，第一条非 tool 消息必须是 assistant 工具调用。
  let activeIndex = -1;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (!message || message.role === "tool") continue;
    if (message.role !== "assistant" || !message.tool_calls?.length) return;
    activeIndex = index;
    break;
  }
  if (activeIndex < 0) return;
  if (!restoreMessageContinuation(conversation[activeIndex]!, originals[activeIndex] ?? null, matchesStamp)) return;
  // 事务内更早的 assistant 工具调用轮同样恢复；印章不匹配或数据缺失的轮次跳过。
  for (let index = activeIndex - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (!message || message.role === "tool") continue;
    if (message.role !== "assistant" || !message.tool_calls?.length) return;
    restoreMessageContinuation(message, originals[index] ?? null, matchesStamp);
  }
}

function restoreMessageContinuation(
  message: ChatMessage,
  original: MessageInfo | null,
  matchesStamp: (state: MessageProviderState) => boolean,
): boolean {
  if (!original?.provider_state) return false;
  if (!matchesStamp(original.provider_state)) return false;
  const state = original.provider_state.state;
  const expected = new Set(message.tool_calls?.map((call) => call.id) ?? []);
  if (state.toolCallIds.length !== expected.size || !state.toolCallIds.every((id) => expected.has(id))) return false;
  message.provider_continuation = state;
  return true;
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
