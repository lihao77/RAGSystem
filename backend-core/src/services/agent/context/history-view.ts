/**
 * 历史视图:过滤 / 压缩视图 / messagesToConversation(自 SDK context/history-view.ts 迁入)。
 *
 * 字段适配:backend MessageInfo 为 snake_case(tool_calls / tool_call_id),本文件引用相应调整;
 * 其余字段(role/content/metadata/seq/name)与 SDK 一致。核心逻辑零改动。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { MessageInfo } from "../../../contracts/session/session.js";
import { numberOrNull } from "./helpers.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";
import { hasAgentVisibleMessageContent } from "./message-content-projector.js";

interface CompressionViewResolution {
  messages: MessageInfo[];
  applied: boolean;
  summarySeq: number | null;
  replacesUpToSeq: number | null;
}

export function resolveCompressionView(messages: MessageInfo[]): MessageInfo[] {
  return resolveCompressionViewDetailed(messages).messages;
}

export function resolveHistoryView(messages: MessageInfo[]): MessageInfo[] {
  const filtered = filterHistoryMessages(messages);
  return resolveCompressionViewDetailed(filtered).messages;
}

export function filterHistoryMessages(messages: MessageInfo[]): MessageInfo[] {
  return messages.filter((message) => {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system" && message.role !== "tool") {
      return false;
    }
    const metadata = message.metadata ?? {};
    if (!hasAgentVisibleMessageContent(message.content_parts, message.role)
      && !(message.role === "assistant" && message.tool_calls?.length)) {
      return false;
    }
    if (metadata.display_only) {
      return false;
    }
    if (metadata.hidden) {
      return false;
    }
    return true;
  });
}

export function resolveCompressionViewDetailed(messages: MessageInfo[]): CompressionViewResolution {
  if (messages.length === 0) {
    return { messages: [], applied: false, summarySeq: null, replacesUpToSeq: null };
  }
  let compressionMessage: MessageInfo | null = null;
  let compressionIndex = -1;
  for (const [index, message] of messages.entries()) {
    if (message.metadata.msg_type !== MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY) {
      continue;
    }
    if (!compressionMessage || message.seq > compressionMessage.seq) {
      compressionMessage = message;
      compressionIndex = index;
    }
  }
  if (!compressionMessage) {
    return { messages: [...messages], applied: false, summarySeq: null, replacesUpToSeq: null };
  }
  const replacesUpToSeq = numberOrNull(compressionMessage.metadata.replaces_up_to_seq);
  const cutoff = replacesUpToSeq ?? compressionMessage.seq;
  // 摘要对模型以 user role 呈现(桥接叙事锚点:摘要不是"模型自己说过的话";同时满足
  // Anthropic 首条必须 user 的约束)。存储层 role 保持 assistant 不动,UI 展示不受影响。
  const output: MessageInfo[] = [{ ...compressionMessage, role: "user", metadata: { msg_type: MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY } }];
  for (const [index, message] of messages.entries()) {
    if (index === compressionIndex || message.metadata.msg_type === MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY) {
      continue;
    }
    if (message.seq > cutoff) {
      output.push(message);
    }
  }
  return { messages: output, applied: true, summarySeq: compressionMessage.seq, replacesUpToSeq };
}

export function messagesToConversation(messages: MessageInfo[]): { conversation: ChatMessage[]; originals: (MessageInfo | null)[] } {
  const conversation: ChatMessage[] = [];
  // 与 conversation 逐条对齐的 rawMessage 来源;供调试快照按 index 回绑元数据。悬空 tool_use 不补占位——保留供 SDK 通用开始契约(kernel.collectUnansweredToolCalls)恢复时重执行。
  const originals: (MessageInfo | null)[] = [];
  // orphan guard:丢弃无前置 assistant tool_use 的孤立 tool_result(压缩切片/历史数据防御,避免 Anthropic tool_result without preceding tool_use)。
  const seenToolUseIds = new Set<string>();
  for (const message of stabilizeFollowupOrder(messages)) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system" && message.role !== "tool") {
      continue;
    }
    if (message.role === "tool" && message.tool_call_id && !seenToolUseIds.has(message.tool_call_id)) {
      continue;
    }
    const entry: ChatMessage = { role: message.role, content: message.content };
    if (message.role === "tool" && message.tool_call_id) {
      entry.tool_call_id = message.tool_call_id;
      if (message.name) {
        entry.name = message.name;
      }
    }
    if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
      entry.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.function.name, arguments: call.function.arguments },
      }));
      for (const call of message.tool_calls) {
        if (call.id) {
          seenToolUseIds.add(call.id);
        }
      }
    }
    conversation.push(entry);
    originals.push(message);
  }
  return { conversation, originals };
}

/**
 * A follow-up can be accepted while tool execution is still persisting results.
 * Keep it out of the durable tool transaction until every result is present;
 * unresolved transactions leave it for the next round refresher after restart.
 */
function stabilizeFollowupOrder(messages: MessageInfo[]): MessageInfo[] {
  const output: MessageInfo[] = [];
  const pendingToolCallIds = new Set<string>();
  let bufferedFollowups: MessageInfo[] = [];
  for (const message of messages) {
    const isFollowup = message.role === "user" && message.metadata.execution_kind === "session_followup";
    if (pendingToolCallIds.size > 0 && isFollowup) {
      bufferedFollowups.push(message);
      continue;
    }
    output.push(message);
    if (message.role === "assistant" && message.tool_calls?.length) {
      pendingToolCallIds.clear();
      for (const call of message.tool_calls) {
        if (call.id) pendingToolCallIds.add(call.id);
      }
      continue;
    }
    if (message.role === "tool" && message.tool_call_id) {
      pendingToolCallIds.delete(message.tool_call_id);
      if (pendingToolCallIds.size === 0 && bufferedFollowups.length > 0) {
        output.push(...bufferedFollowups);
        bufferedFollowups = [];
      }
    }
  }
  return output;
}
