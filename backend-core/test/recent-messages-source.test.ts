import { describe, expect, it, vi } from "vitest";

import { MSG_TYPE } from "../src/contracts/message-kinds.js";
import type { MessageProviderState } from "../src/contracts/conversation-store/types.js";
import type { MessageInfo } from "../src/contracts/session/session.js";
import type { ConversationHistoryPort } from "../src/services/agent/context/types.js";
import { ProjectionRegistry } from "../src/services/agent/context/extensions/registry.js";
import { RecentMessagesContextSource } from "../src/services/agent/context/recent-messages-source.js";

function message(overrides: Partial<MessageInfo>): MessageInfo {
  return {
    id: "message-1",
    seq: 1,
    session_id: "session-1",
    role: "assistant",
    content: "",
    content_parts: [],
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    thread_key: "root",
    child_agent_id: null,
    ...overrides,
  };
}

describe("RecentMessagesContextSource", () => {
  it("preserves every tool observation until a formal compression summary replaces it", async () => {
    const history = Array.from({ length: 7 }, (_, index) => {
      const callId = `call-${index + 1}`;
      const content = `complete observation ${index + 1}`;
      return [
        message({
          id: `intent-${index + 1}`,
          seq: index * 2 + 1,
          metadata: { msg_type: MSG_TYPE.INTENT },
          tool_calls: [{
            id: callId,
            type: "function",
            function: { name: "read", arguments: "{}" },
          }],
        }),
        message({
          id: `observation-${index + 1}`,
          seq: index * 2 + 2,
          role: "tool",
          content,
          content_parts: [{ type: "text", text: content }],
          metadata: { msg_type: MSG_TYPE.OBSERVATION },
          tool_call_id: callId,
          name: "read",
        }),
      ];
    }).flat();
    const historyPort = {
      getRecentMessages: vi.fn(async () => history),
    };
    const source = new RecentMessagesContextSource(
      historyPort,
      false,
      new ProjectionRegistry(),
    );

    const result = await source.build({
      sessionId: "session-1",
      threadKey: "root",
      cacheAlive: false,
      touch: false,
    });

    expect(result.conversation?.filter((entry) => entry.role === "tool").map((entry) => entry.content)).toEqual(
      Array.from({ length: 7 }, (_, index) => `complete observation ${index + 1}`),
    );
  });

  const providerStateOf = (callId: string, thinking: string, providerKey = "kimi", model = "k3"): MessageProviderState => ({
    provider_key: providerKey,
    model,
    state: {
      protocol: "anthropic_messages",
      toolCallIds: [callId],
      blocks: [{ type: "thinking", thinking, signature: `sig-${callId}` }],
    },
  });

  /** 未关闭的两轮工具事务：user → A1(tool₁) → T1 → A2(tool₂) → T2。 */
  function openTransactionHistory(states: Record<string, MessageProviderState | null> = {}): MessageInfo[] {
    const call = (id: string, seq: number) => message({
      id: `intent-${id}`,
      seq,
      role: "assistant",
      metadata: { msg_type: MSG_TYPE.INTENT },
      tool_calls: [{
        id: `call-${id}`,
        type: "function" as const,
        function: { name: "read", arguments: "{}" },
      }],
      ...(states[`intent-${id}`] ? { provider_state: states[`intent-${id}`] } : {}),
    });
    const observation = (id: string, seq: number) => message({
      id: `observation-${id}`,
      seq,
      role: "tool",
      content: `result ${id}`,
      content_parts: [{ type: "text", text: `result ${id}` }],
      metadata: { msg_type: MSG_TYPE.OBSERVATION },
      tool_call_id: `call-${id}`,
      name: "read",
    });
    return [
      message({ id: "user-1", seq: 1, role: "user", content: "do it", content_parts: [{ type: "text", text: "do it" }], metadata: {} }),
      call("1", 2),
      observation("1", 3),
      call("2", 4),
      observation("2", 5),
    ];
  }

  async function buildConversation(
    history: MessageInfo[],
    providerIdentity: { providerKey: string; model: string } | null = { providerKey: "kimi", model: "k3" },
  ) {
    const historyPort: ConversationHistoryPort = {
      getRecentMessages: vi.fn(async () => history),
    } as ConversationHistoryPort;
    const source = new RecentMessagesContextSource(historyPort, false, new ProjectionRegistry(), null, providerIdentity);
    const result = await source.build({ sessionId: "session-1", threadKey: "root", cacheAlive: false, touch: false });
    return result.conversation ?? [];
  }

  it("restores hidden reasoning for every assistant round inside an open tool transaction", async () => {
    const conversation = await buildConversation(openTransactionHistory({
      "intent-1": providerStateOf("call-1", "round one"),
      "intent-2": providerStateOf("call-2", "round two"),
    }));

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.provider_continuation).toEqual(providerStateOf("call-1", "round one").state);
    expect(assistants[1]!.provider_continuation).toEqual(providerStateOf("call-2", "round two").state);
  });

  it("degrades cross-model rounds to <think> text instead of dropping or replaying signatures", async () => {
    // 事务由 kimi/k3 与 kimi/k3.5 混合签发，当前 run 是 kimi/k3（pi 语义）：
    // 匹配轮原样回放；不匹配轮的签名对该模型无效，思考文本降级为 <think> 正文注入。
    const conversation = await buildConversation(openTransactionHistory({
      "intent-1": providerStateOf("call-1", "round one"),
      "intent-2": providerStateOf("call-2", "round two", "kimi", "k3.5"),
    }));

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants[0]!.provider_continuation).toEqual(providerStateOf("call-1", "round one").state);
    expect(assistants[1]!.provider_continuation).toBeUndefined();
    expect(JSON.stringify(assistants[1]!.content)).toContain("<think>");
    expect(JSON.stringify(assistants[1]!.content)).toContain("round two");
  });

  it("restores stamped rounds independently; later rounds missing state do not block earlier ones", async () => {
    const conversation = await buildConversation(openTransactionHistory({
      "intent-1": providerStateOf("call-1", "round one"),
    }));

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants[0]!.provider_continuation).toEqual(providerStateOf("call-1", "round one").state);
    expect(assistants[1]!.provider_continuation).toBeUndefined();
  });

  it("restores across closed transactions, including the text-only final round", async () => {
    const finalState: MessageProviderState = {
      provider_key: "kimi",
      model: "k3",
      state: {
        protocol: "anthropic_messages",
        toolCallIds: [],
        blocks: [{ type: "thinking", thinking: "final reasoning", signature: "sig-final" }],
      },
    };
    const history = [
      ...openTransactionHistory({
        "intent-1": providerStateOf("call-1", "round one"),
        "intent-2": providerStateOf("call-2", "round two"),
      }),
      message({
        id: "final-1",
        seq: 6,
        role: "assistant",
        content: "done",
        content_parts: [{ type: "text", text: "done" }],
        metadata: { msg_type: MSG_TYPE.ASSISTANT_FINAL },
        provider_state: finalState,
      }),
      message({ id: "user-2", seq: 7, role: "user", content: "next question", content_parts: [{ type: "text", text: "next question" }], metadata: {} }),
    ];
    const conversation = await buildConversation(history);

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants.every((entry) => entry.provider_continuation !== undefined)).toBe(true);
    expect(assistants[2]!.provider_continuation).toEqual(finalState.state);
  });

  it("drops redacted-only reasoning on cross-model rounds without injecting text", async () => {
    const redactedState: MessageProviderState = {
      provider_key: "kimi",
      model: "k3",
      state: {
        protocol: "anthropic_messages",
        toolCallIds: ["call-1"],
        blocks: [{ type: "redacted_thinking", data: "opaque" }],
      },
    };
    const conversation = await buildConversation(
      openTransactionHistory({ "intent-1": redactedState }),
      { providerKey: "kimi", model: "k3.5" },
    );

    expect(conversation.every((entry) => entry.provider_continuation === undefined)).toBe(true);
    expect(JSON.stringify(conversation)).not.toContain("<think>");
  });

  it("degrades openai_chat reasoning_content cross-model via <think> text", async () => {
    const chatState: MessageProviderState = {
      provider_key: "deepseek",
      model: "deepseek-v4-pro",
      state: {
        protocol: "openai_chat",
        toolCallIds: ["call-1"],
        assistantFields: { reasoning_content: "deepseek thought" },
      },
    };
    const conversation = await buildConversation(
      openTransactionHistory({ "intent-1": chatState }),
      { providerKey: "deepseek", model: "deepseek-v4-pro-preview" },
    );

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants[0]!.provider_continuation).toBeUndefined();
    expect(JSON.stringify(assistants[0]!.content)).toContain("deepseek thought");
  });

  it("leaves encrypted responses reasoning items unreadable cross-model", async () => {
    const responsesState: MessageProviderState = {
      provider_key: "openai",
      model: "gpt-test",
      state: {
        protocol: "openai_responses",
        toolCallIds: ["call-1"],
        anchorCallId: "call-1",
        reasoningItems: [{ type: "reasoning", id: "rs-1", encrypted_content: "RSN(enc)" }],
      },
    };
    const conversation = await buildConversation(
      openTransactionHistory({ "intent-1": responsesState }),
      { providerKey: "openai", model: "gpt-other" },
    );

    expect(conversation.every((entry) => entry.provider_continuation === undefined)).toBe(true);
    expect(JSON.stringify(conversation)).not.toContain("<think>");
  });

  it("synthesizes tool results for tool calls interrupted before execution", async () => {
    // 崩溃窗口：第二轮 assistant 工具调用已落库、结果未落库。
    const history = openTransactionHistory().slice(0, 4); // user → A1 → T1 → A2（无 T2）
    const conversation = await buildConversation(history);

    const lastEntry = conversation[conversation.length - 1]!;
    expect(lastEntry.role).toBe("tool");
    expect(lastEntry.tool_call_id).toBe("call-2");
    expect(lastEntry.content).toContain("No result provided");
  });
});
