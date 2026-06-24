/**
 * 历史视图：过滤 / 压缩视图 / messagesToConversation / microcompact（迁自 backend-ts）。
 * 删 attachment-resolver 依赖（SDK 不处理附件）。核心逻辑零改动。
 */
import type { ChatMessage } from "@ragsystem/agent-llm";
import type { MessageInfo } from "../types.js";
import { MICROCOMPACT_CLEARED_LABEL } from "./types.js";
import { numberOrNull } from "./helpers.js";

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
    const metadataType = metadata.type;
    if (metadataType === "command_result") {
      return false;
    }
    if (metadataType === "command" && metadata.command_mode !== "prompt") {
      return false;
    }
    if (metadata.display_only) {
      return false;
    }
    if (metadata.hidden) {
      return false;
    }
    if (message.role === "assistant" && metadata.interrupted) {
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
    if (!message.metadata.compression) {
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
  const output: MessageInfo[] = [{ ...compressionMessage, role: "assistant", metadata: { compression: true } }];
  for (const [index, message] of messages.entries()) {
    if (index === compressionIndex || message.metadata.compression) {
      continue;
    }
    if (message.seq > cutoff) {
      output.push(message);
    }
  }
  return { messages: output, applied: true, summarySeq: compressionMessage.seq, replacesUpToSeq };
}

const UNANSWERED_TOOL_PLACEHOLDER = "工具未返回结果";

export function messagesToConversation(messages: MessageInfo[]): ChatMessage[] {
  const answeredToolCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      answeredToolCallIds.add(message.toolCallId);
    }
  }
  const conversation: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "system" && message.role !== "tool") {
      continue;
    }
    conversation.push({ role: message.role, content: message.content });
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        if (toolCall.id && !answeredToolCallIds.has(toolCall.id)) {
          conversation.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function?.name ?? "",
            content: UNANSWERED_TOOL_PLACEHOLDER,
          });
          answeredToolCallIds.add(toolCall.id);
        }
      }
    }
  }
  return conversation;
}

export interface MicrocompactResult {
  messages: MessageInfo[];
  observationCount: number;
  clearedCount: number;
}

export function microcompactHistoryMessages(messages: MessageInfo[], keepRecentTools: number): MicrocompactResult {
  const observationIndices = messages
    .map((message, index) => (message.metadata.msg_type === "observation" ? index : -1))
    .filter((index) => index >= 0);
  if (observationIndices.length === 0 || observationIndices.length <= keepRecentTools) {
    return { messages, observationCount: observationIndices.length, clearedCount: 0 };
  }
  const clearIndices = new Set(observationIndices.slice(0, observationIndices.length - keepRecentTools));
  let clearedCount = 0;
  const compacted = messages.map((message, index) => {
    if (!clearIndices.has(index)) {
      return message;
    }
    const nextContent = microcompactClearedContent(message);
    if (message.content === nextContent) {
      return message;
    }
    clearedCount += 1;
    return { ...message, content: nextContent };
  });
  return { messages: compacted, observationCount: observationIndices.length, clearedCount };
}

export function countObservationMessages(messages: MessageInfo[]): number {
  return messages.filter((message) => message.metadata.msg_type === "observation").length;
}

function microcompactClearedContent(message: MessageInfo): string {
  if (message.content === MICROCOMPACT_CLEARED_LABEL || message.content.startsWith("[工具结果已清理")) {
    return message.content;
  }
  const round = message.metadata.round;
  return typeof round === "number" && Number.isFinite(round) ? `[工具结果已清理，轮次 ${round}]` : MICROCOMPACT_CLEARED_LABEL;
}
