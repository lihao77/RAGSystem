import { describe, expect, it } from "vitest";

import type { MessageInfo } from "../../src/contracts/session.js";
import {
  AgentRuntimeContextBuilder,
  EmptyMemoryContextSource,
  RecentMessagesContextSource,
  type AgentRuntimeContextSource,
  type RuntimeConversationHistoryPort,
} from "../../src/services/agent-runtime-context-builder.js";

class InMemoryHistory implements RuntimeConversationHistoryPort {
  readonly calls: Array<{ sessionId: string; limit: number | undefined; threadKey: string | null | undefined }> = [];

  constructor(private readonly messages: MessageInfo[]) {}

  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): MessageInfo[] {
    this.calls.push({ sessionId, limit, threadKey });
    return this.messages.slice(0, limit);
  }
}

describe("AgentRuntimeContextBuilder", () => {
  it("builds minimal runtime conversation from recent root user and assistant messages", () => {
    const history = new InMemoryHistory([
      message("user", "hello"),
      message("assistant", "hi"),
      message("system", "internal"),
      message("tool", "tool result"),
    ]);
    const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(history)]);

    const context = builder.buildContext({ sessionId: "s1" });

    expect(history.calls).toEqual([{ sessionId: "s1", limit: 20, threadKey: "root" }]);
    expect(context).toEqual({
      conversation: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      metadata: {
        session_id: "s1",
        thread_key: "root",
        history_limit: 20,
        sources: [
          {
            name: "recent_messages",
            message_count: 2,
            metadata: {
              source_message_count: 4,
            },
          },
        ],
      },
    });
  });

  it("supports explicit thread key and history limit", () => {
    const history = new InMemoryHistory([message("user", "child hello"), message("assistant", "child answer")]);
    const builder = new AgentRuntimeContextBuilder([new RecentMessagesContextSource(history)]);

    const context = builder.buildContext({
      sessionId: "s2",
      threadKey: "child:worker",
      historyLimit: 1,
    });

    expect(history.calls).toEqual([{ sessionId: "s2", limit: 1, threadKey: "child:worker" }]);
    expect(context).toMatchObject({
      conversation: [{ role: "user", content: "child hello" }],
      metadata: {
        session_id: "s2",
        thread_key: "child:worker",
        history_limit: 1,
        sources: [
          {
            name: "recent_messages",
            message_count: 1,
          },
        ],
      },
    });
  });

  it("combines context source contributions in declaration order", () => {
    const history = new InMemoryHistory([message("user", "hello")]);
    const syntheticSource: AgentRuntimeContextSource = {
      name: "synthetic",
      build: () => ({
        conversation: [{ role: "assistant", content: "synthetic context" }],
        metadata: { mode: "test" },
      }),
    };
    const builder = new AgentRuntimeContextBuilder([
      new RecentMessagesContextSource(history),
      syntheticSource,
      new EmptyMemoryContextSource(),
    ]);

    const context = builder.buildContext({ sessionId: "s3" });

    expect(context.conversation).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "synthetic context" },
    ]);
    expect(context.metadata.sources).toEqual([
      expect.objectContaining({ name: "recent_messages", message_count: 1 }),
      {
        name: "synthetic",
        message_count: 1,
        metadata: { mode: "test" },
      },
      {
        name: "memory",
        message_count: 0,
        metadata: { status: "not_loaded" },
      },
    ]);
  });
});

function message(role: MessageInfo["role"], content: string): MessageInfo {
  return {
    seq: 1,
    id: `${role}-${content}`,
    session_id: "s1",
    role,
    content,
    metadata: {},
    thread_key: "root",
    child_agent_id: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}
