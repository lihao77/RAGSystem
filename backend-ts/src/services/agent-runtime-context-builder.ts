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
    sources: Array<{
      name: string;
      message_count: number;
      metadata?: Record<string, unknown>;
    }>;
  };
}

export interface AgentRuntimeContextContribution {
  conversation?: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface AgentRuntimeContextSource {
  readonly name: string;
  build(request: ResolvedAgentRuntimeContextRequest): AgentRuntimeContextContribution;
}

interface ResolvedAgentRuntimeContextRequest {
  sessionId: string;
  threadKey: string;
  historyLimit: number;
}

const DEFAULT_HISTORY_LIMIT = 20;
const DEFAULT_THREAD_KEY = "root";

export class AgentRuntimeContextBuilder {
  constructor(private readonly sources: AgentRuntimeContextSource[]) {}

  buildContext(request: AgentRuntimeContextRequest): AgentRuntimeContext {
    const resolved = resolveContextRequest(request);
    const conversation: ChatMessage[] = [];
    const sourceMetadata: AgentRuntimeContext["metadata"]["sources"] = [];
    for (const source of this.sources) {
      const contribution = source.build(resolved);
      const messages = contribution.conversation ?? [];
      conversation.push(...messages);
      sourceMetadata.push({
        name: source.name,
        message_count: messages.length,
        ...(contribution.metadata ? { metadata: contribution.metadata } : {}),
      });
    }
    return {
      conversation,
      metadata: {
        session_id: resolved.sessionId,
        thread_key: resolved.threadKey,
        history_limit: resolved.historyLimit,
        sources: sourceMetadata,
      },
    };
  }
}

export class RecentMessagesContextSource implements AgentRuntimeContextSource {
  readonly name = "recent_messages";

  constructor(private readonly history: RuntimeConversationHistoryPort) {}

  build(request: ResolvedAgentRuntimeContextRequest): AgentRuntimeContextContribution {
    const messages = this.history.getRecentMessages(request.sessionId, request.historyLimit, request.threadKey);
    return {
      conversation: messagesToConversation(messages),
      metadata: {
        source_message_count: messages.length,
      },
    };
  }
}

export class EmptyMemoryContextSource implements AgentRuntimeContextSource {
  readonly name = "memory";

  build(): AgentRuntimeContextContribution {
    return {
      conversation: [],
      metadata: {
        status: "not_loaded",
      },
    };
  }
}

function resolveContextRequest(request: AgentRuntimeContextRequest): ResolvedAgentRuntimeContextRequest {
  return {
    sessionId: request.sessionId,
    threadKey: request.threadKey?.trim() || DEFAULT_THREAD_KEY,
    historyLimit: request.historyLimit ?? DEFAULT_HISTORY_LIMIT,
  };
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
