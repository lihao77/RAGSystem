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
    // 先恢复（依赖 originals 与 conversation 的索引对齐），再补孤儿结果（会改变数组长度）。
    // 跨模型降级的 <think> 注入延后到内容投影之后落地（投影会重写 content）。
    const degradedThinking: Array<{ message: ChatMessage; wrapped: string }> = [];
    restoreActiveProviderContinuation(conversation, originals, this.providerIdentity, degradedThinking);
    closeOrphanedToolCalls(conversation);
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
    for (const { message, wrapped } of degradedThinking) {
      message.content = typeof message.content === "string"
        ? `${wrapped}\n\n${message.content}`
        : [{ type: "text", text: wrapped }, ...(message.content ?? [])];
    }
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
 * 中断窗口兜底：assistant 工具调用缺对应 tool 结果的，就地补合成结果。
 * 缺 tool_result 的 tool_use 会被各家 API 直接 400；终态 finalize 会补写正式的
 * 终结 tool 消息，这里只覆盖"崩溃在 finalize 之前"的窗口（有正式结果时天然跳过）。
 */
function closeOrphanedToolCalls(conversation: ChatMessage[]): void {
  const answered = new Set(
    conversation.filter((message) => message?.role === "tool").map((message) => message.tool_call_id),
  );
  const patched: ChatMessage[] = [];
  let orphaned = 0;
  for (const message of conversation) {
    patched.push(message);
    if (message?.role !== "assistant" || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      patched.push({ role: "tool", tool_call_id: call.id, content: "No result provided (interrupted before execution)" });
      orphaned += 1;
    }
  }
  if (orphaned === 0) return;
  conversation.length = 0;
  conversation.push(...patched);
}

/**
 * pi 语义的思考回放（消息行内 provider_state，无事务概念）：
 * 1. 印章匹配（同 provider + model）：全历史逐条原样挂载——签名/加密块对该模型仍有效，厂商要求原样回传；
 *    已关闭事务（最终回答之后）的思考同样回放，跨 run 推理连续性依赖于此；
 * 2. 印章不匹配（跨模型）：带文本的思考降级为正文注入（<think> 包裹），redacted/加密无文本的丢弃——
 *    签名与加密块是模型私有的，跨模型回传无效，但思考文本本身对新模型可读。
 */
function restoreActiveProviderContinuation(
  conversation: ChatMessage[],
  originals: (MessageInfo | null)[],
  providerIdentity: { providerKey: string; model: string } | null,
  degradedThinking: Array<{ message: ChatMessage; wrapped: string }>,
): void {
  if (!providerIdentity) return;
  const matchesStamp = (state: MessageProviderState): boolean =>
    state.provider_key === providerIdentity.providerKey && state.model === providerIdentity.model;
  for (let index = 0; index < conversation.length; index += 1) {
    const message = conversation[index];
    if (message?.role !== "assistant") continue;
    const original = originals[index];
    if (!original?.provider_state) continue;
    if (!matchesStamp(original.provider_state)) {
      const thinking = readableThinkingText(original.provider_state.state);
      if (thinking.trim()) degradedThinking.push({ message, wrapped: `<think>\n${thinking}\n</think>` });
      continue;
    }
    restoreMessageContinuation(message, original);
  }
}

function restoreMessageContinuation(message: ChatMessage, original: MessageInfo): void {
  const state = original.provider_state!.state;
  const expected = new Set(message.tool_calls?.map((call) => call.id) ?? []);
  if (state.toolCallIds.length !== expected.size || !state.toolCallIds.every((id) => expected.has(id))) return;
  message.provider_continuation = state;
}

/** 各协议可读的思考文本；openai_responses 的 items 为加密负载，跨模型不可读。 */
function readableThinkingText(state: MessageProviderState["state"]): string {
  if (state.protocol === "anthropic_messages") {
    return state.blocks
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");
  }
  if (state.protocol === "openai_chat") {
    const reasoning = state.assistantFields.reasoning_content ?? state.assistantFields.reasoning;
    return typeof reasoning === "string" ? reasoning : "";
  }
  if (state.protocol === "gemini_generate_content") {
    return state.parts
      .filter((part) => part.thought === true && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
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
