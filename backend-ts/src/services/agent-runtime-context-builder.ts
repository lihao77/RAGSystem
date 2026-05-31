import type { MessageInfo } from "../contracts/session.js";
import type { ChatMessage } from "./llm-chat-client.js";

export interface RuntimeConversationHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[];
}

export interface AgentRuntimeContextRequest {
  sessionId: string;
  threadKey?: string | null;
  historyLimit?: number;
}

export interface AgentRuntimeContext {
  conversation: ChatMessage[];
  metadata: {
    session_id: string;
    thread_key: string;
    history_limit: number;
    source_message_count: number;
  };
}

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_THREAD_KEY = "root";

export class AgentRuntimeContextBuilder {
  constructor(private readonly history: RuntimeConversationHistoryPort) {}

  buildContext(request: AgentRuntimeContextRequest): AgentRuntimeContext {
    const historyLimit = request.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    const threadKey = request.threadKey?.trim() || DEFAULT_THREAD_KEY;
    const messages = this.history.getRecentMessages(request.sessionId, historyLimit, threadKey);
    return {
      conversation: messagesToConversation(messages),
      metadata: {
        session_id: request.sessionId,
        thread_key: threadKey,
        history_limit: historyLimit,
        source_message_count: messages.length,
      },
    };
  }
}

function messagesToConversation(messages: MessageInfo[]): ChatMessage[] {
  const conversation: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      conversation.push({ role: message.role, content: message.content });
    }
  }
  return conversation;
}
