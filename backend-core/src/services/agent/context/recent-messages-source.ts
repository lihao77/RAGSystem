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
    const projected = await this.projectMessages(historyMessages, request);
    return { conversation: projected.conversation, rawMessages: projected.originals, metadata };
  }

  /**
   * 对给定消息行跑与 build() 相同的规范投影，返回模型侧消息（refresh 增量投递用）。
   *
   * 投递方（runtime-adapter refresher）只应投递自己认领/接受的行：对这些行单独投影，
   * 交付物与首次请求同形（command_ref、附件、metadata extensions 一致），且不依赖
   * 全量重建视图的几何——conversation/originals 的索引对齐曾因孤儿补齐插入而错位，
   * 按索引从全量视图筛选会把真实 tool 消息误当"新认领的 user 消息"追加（同
   * tool_call_id 重复应答，OpenAI 兼容协议 400）。行内再过一次 filterHistoryMessages，
   * 与全量路径的可见性语义一致。
   *
   * 与全量路径的一处有意分歧：不经过 stabilizeFollowupOrder（全量历史的事务序稳定器，
   * 会把 store 侧工具事务未落齐窗口内的 session_followup user 行 buffer 掉）。子集投递
   * 落在工作副本已含完整内存态 tool 结果之后，store 滞后只是持久化现象，立即投递更
   * 正确——后人不要为"路径一致"把 buffer 语义加回子集。
   */
  async projectRows(rows: readonly MessageInfo[], request: ResolvedAgentContextRequest): Promise<ChatMessage[]> {
    const projected = await this.projectMessages(filterHistoryMessages([...rows]), request);
    return projected.conversation;
  }

  /** build()/projectRows() 共享的投影核心：压缩视图行 → 对齐的 conversation/originals。 */
  private async projectMessages(
    historyMessages: MessageInfo[],
    request: ResolvedAgentContextRequest,
  ): Promise<{ conversation: ChatMessage[]; originals: (MessageInfo | null)[] }> {
    const { conversation, originals } = messagesToConversation(historyMessages);
    // 先恢复（依赖 originals 与 conversation 的索引对齐），再补孤儿结果（会改变数组长度，
    // 插入时同步补 null 占位保持对齐——调试快照（monitoring）按 index 回绑元数据等消费
    // 者依赖该契约，错位曾把真实 tool 消息误当新 user 消息追加，制造重复 tool_call 应答
    //（OpenAI 兼容协议 400；refresh 投递已改走 projectRows，不再依赖索引））。
    // 跨模型降级的 <think> 注入延后到内容投影之后落地（投影会重写 content）。
    const degradedThinking: Array<{ message: ChatMessage; wrapped: string }> = [];
    restoreActiveProviderContinuation(conversation, originals, this.providerIdentity, degradedThinking);
    closeOrphanedToolCalls(conversation, originals);
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
    return { conversation, originals };
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
 *
 * 插入合成消息时必须同步向 originals 补 null 占位：两者是逐 index 对齐的返回契约
 * （调试快照按索引回绑元数据等消费者依赖；refresh 投递曾按索引识别"新接受的
 * user 消息"，已改走 projectRows），只增长 conversation 会让插入点之后整体错位——
 * 曾把真实 tool 消息误判为新 user 消息追加，
 * 产生同 tool_call_id 的重复应答（OpenAI 400: tool must be a response to preceding
 * tool_calls）。
 */
function closeOrphanedToolCalls(conversation: ChatMessage[], originals: (MessageInfo | null)[]): void {
  const answered = new Set(
    conversation.filter((message) => message?.role === "tool").map((message) => message.tool_call_id),
  );
  const patched: ChatMessage[] = [];
  const patchedOriginals: (MessageInfo | null)[] = [];
  let orphaned = 0;
  for (let index = 0; index < conversation.length; index += 1) {
    const message = conversation[index]!;
    patched.push(message);
    patchedOriginals.push(originals[index] ?? null);
    if (message?.role !== "assistant" || !message.tool_calls?.length) continue;
    for (const call of message.tool_calls) {
      if (answered.has(call.id)) continue;
      patched.push({ role: "tool", tool_call_id: call.id, content: "No result provided (interrupted before execution)" });
      patchedOriginals.push(null);
      orphaned += 1;
    }
  }
  if (orphaned === 0) return;
  conversation.length = 0;
  conversation.push(...patched);
  originals.length = 0;
  originals.push(...patchedOriginals);
}

/**
 * pi 语义的思考回放（消息行内 provider_state，无事务概念）：
 * 1. 印章匹配（同 provider + model）：全历史逐条原样挂载——签名/加密块对该模型仍有效，厂商要求原样回传；
 *    已关闭事务（最终回答之后）的思考同样回放，跨 run 推理连续性依赖于此；
 * 2. 印章不匹配（跨模型），或行上没有 provider_state（terminal salvage 行——中断轮没有
 *    有效续跑态；以及 toolCallIds 配对失败被丢弃状态的轮）：带文本的思考降级为正文注入
 *    （<think> 包裹），redacted/加密无文本的丢弃——签名与加密块是模型私有的，跨模型回传
 *    无效，但思考文本本身对新模型可读。没有这一支，中断前的盘算对下一轮不可见。
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
  const degradeToText = (message: ChatMessage, original: MessageInfo | null | undefined): void => {
    if (!original) return;
    const thinking = readableThinkingText(original);
    if (thinking.trim()) degradedThinking.push({ message, wrapped: `<think>\n${thinking}\n</think>` });
  };
  for (let index = 0; index < conversation.length; index += 1) {
    const message = conversation[index];
    if (message?.role !== "assistant") continue;
    const original = originals[index];
    if (!original?.provider_state) {
      degradeToText(message, original);
      continue;
    }
    if (!matchesStamp(original.provider_state)) {
      degradeToText(message, original);
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

/** 跨模型降级的思考文本：只读消息行 thinking part（一等内容，单一数据源无回退）；签名/加密块对其他模型无效，不解读。 */
function readableThinkingText(original: MessageInfo): string {
  return original.content_parts
    .filter((part) => part.type === "thinking")
    .map((part) => part.text)
    .join("");
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
