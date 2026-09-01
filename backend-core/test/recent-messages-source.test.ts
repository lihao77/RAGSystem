import { describe, expect, it, vi } from "vitest";

import { MSG_TYPE } from "../src/contracts/message-kinds.js";
import type { MessageProviderState } from "../src/contracts/conversation-store/types.js";
import type { MessageInfo } from "../src/contracts/session/session.js";
import type { ConversationHistoryPort } from "../src/services/agent/context/types.js";
import { createDefaultProjectionRegistry } from "../src/services/agent/context/extensions/index.js";
import { ProjectionRegistry } from "../src/services/agent/context/extensions/registry.js";
import { RecentMessagesContextSource } from "../src/services/agent/context/recent-messages-source.js";

function message(overrides: Partial<MessageInfo>): MessageInfo {
  return {
    id: "message-1",
    seq: 1,
    session_id: "session-1",
    role: "assistant",
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
          metadata: { msg_type: MSG_TYPE.ROUND },
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
  function openTransactionHistory(
    states: Record<string, MessageProviderState | null> = {},
    thinkingParts: Record<string, string> = {},
  ): MessageInfo[] {
    const call = (id: string, seq: number) => message({
      id: `intent-${id}`,
      seq,
      role: "assistant",
      content_parts: thinkingParts[`intent-${id}`]
        ? [{ type: "thinking" as const, text: thinkingParts[`intent-${id}`]!, round: Number(id), complete: true }]
        : [],
      metadata: { msg_type: MSG_TYPE.ROUND },
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
      content_parts: [{ type: "text", text: `result ${id}` }],
      metadata: { msg_type: MSG_TYPE.OBSERVATION },
      tool_call_id: `call-${id}`,
      name: "read",
    });
    return [
      message({ id: "user-1", seq: 1, role: "user", content_parts: [{ type: "text", text: "do it" }], metadata: {} }),
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
    // 匹配轮原样回放；不匹配轮签名对该模型无效，thinking part 文本降级为 <think> 正文注入。
    const conversation = await buildConversation(
      openTransactionHistory(
        {
          "intent-1": providerStateOf("call-1", "round one"),
          "intent-2": providerStateOf("call-2", "round two", "kimi", "k3.5"),
        },
        { "intent-1": "round one", "intent-2": "round two" },
      ),
    );

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]!.provider_continuation).toEqual(providerStateOf("call-1", "round one").state);
    expect(assistants[1]!.provider_continuation).toBeUndefined();
    expect(JSON.stringify(assistants[1]!.content)).toContain("<think>");
    expect(JSON.stringify(assistants[1]!.content)).toContain("round two");
  });

  it("skips degrade injection when the mismatched round has no thinking part (single source, no provider_state fallback)", async () => {
    // 跨模型轮只有 provider_state、没有 thinking part：不注入任何文本（思考文本单一数据源）。
    const conversation = await buildConversation(openTransactionHistory({
      "intent-1": providerStateOf("call-1", "round one", "kimi", "k3.5"),
    }));

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants[0]!.provider_continuation).toBeUndefined();
    expect(JSON.stringify(conversation)).not.toContain("<think>");
  });

  it("restores stamped rounds independently; later rounds missing state do not block earlier ones", async () => {
    const conversation = await buildConversation(openTransactionHistory({
      "intent-1": providerStateOf("call-1", "round one"),
    }));

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants[0]!.provider_continuation).toEqual(providerStateOf("call-1", "round one").state);
    expect(assistants[1]!.provider_continuation).toBeUndefined();
  });

  it("injects terminal salvage thinking as <think> when the interrupted round has no provider_state", async () => {
    // 中断 run：工具轮正常回放；最终轮 salvage 思考落在 terminal 行——中断轮没有有效
    // 续跑态（无 provider_state）。文本降级注入，下一轮模型才能看到中断前的盘算。
    const history = [
      ...openTransactionHistory({ "intent-1": providerStateOf("call-1", "round one") }),
      message({
        id: "terminal-1",
        seq: 6,
        role: "assistant",
        content_parts: [
          { type: "thinking" as const, text: "salvaged half-thinking", complete: false },
          { type: "text", text: "本次运行已中断，未生成最终答案。原因：用户主动停止运行" },
        ],
        metadata: { msg_type: MSG_TYPE.RUN_TERMINAL, terminal_status: "interrupted", visible_to_user: true },
      }),
      message({ id: "user-2", seq: 7, role: "user", content_parts: [{ type: "text", text: "你可以看到停止前的思考吗" }], metadata: {} }),
    ];
    const conversation = await buildConversation(history);

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants[0]!.provider_continuation).toEqual(providerStateOf("call-1", "round one").state);
    const terminal = assistants.at(-1)!;
    expect(terminal.provider_continuation).toBeUndefined();
    expect(JSON.stringify(terminal.content)).toContain("<think>");
    expect(JSON.stringify(terminal.content)).toContain("salvaged half-thinking");
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
        content_parts: [{ type: "text", text: "done" }],
        metadata: { msg_type: MSG_TYPE.ROUND },
        provider_state: finalState,
      }),
      message({ id: "user-2", seq: 7, role: "user", content_parts: [{ type: "text", text: "next question" }], metadata: {} }),
    ];
    const conversation = await buildConversation(history);

    const assistants = conversation.filter((entry) => entry.role === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants.every((entry) => entry.provider_continuation !== undefined)).toBe(true);
    expect(assistants[2]!.provider_continuation).toEqual(finalState.state);
  });

  it("keeps zero-content thinking-only rounds: restored on stamp match, degraded cross-model", async () => {
    const emptyFinal: MessageProviderState = {
      provider_key: "kimi",
      model: "k3",
      state: {
        protocol: "anthropic_messages",
        toolCallIds: [],
        blocks: [{ type: "thinking", thinking: "thought without an answer", signature: "sig-empty" }],
      },
    };
    const history = [
      message({ id: "user-1", seq: 1, role: "user", content_parts: [{ type: "text", text: "go" }], metadata: {} }),
      // 零正文纯思考轮（如 length 截断在思考段）：无 content_parts、无 tool_calls，仅 provider_state
      message({
        id: "final-empty",
        seq: 2,
        role: "assistant",
        content_parts: [{ type: "thinking" as const, text: "thought without an answer", complete: false }],
        metadata: { msg_type: MSG_TYPE.ROUND },
        provider_state: emptyFinal,
      }),
      message({ id: "user-2", seq: 3, role: "user", content_parts: [{ type: "text", text: "again" }], metadata: {} }),
    ];

    const matched = await buildConversation(history);
    const matchedAssistant = matched.filter((entry) => entry.role === "assistant");
    expect(matchedAssistant).toHaveLength(1);
    expect(matchedAssistant[0]!.provider_continuation).toEqual(emptyFinal.state);

    const crossModel = await buildConversation(history, { providerKey: "kimi", model: "k3.5" });
    const degraded = crossModel.filter((entry) => entry.role === "assistant");
    expect(degraded).toHaveLength(1);
    expect(degraded[0]!.provider_continuation).toBeUndefined();
    expect(JSON.stringify(degraded[0]!.content)).toContain("thought without an answer");
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
      openTransactionHistory({ "intent-1": chatState }, { "intent-1": "deepseek thought" }),
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

  it("keeps originals index-aligned when closing orphaned tool calls (refresh misdelivery regression)", async () => {
    // 2026-08-31 线上 400 的失败形状：并行工具批次部分落库（call-1 未落、call-2 已落），
    // 其后紧跟刚被 refresh 认领的 user 消息。closeOrphanedToolCalls 插入合成结果后，
    // conversation 与 rawMessages 必须保持逐 index 对齐——错位曾让按索引筛选的消费者
    // 把真实 tool 消息误当"新接受的 user 消息"追加，产生同 tool_call_id 的重复应答
    //（OpenAI 兼容协议 400）。refresh 投递已改走 projectRows（不依赖该对齐），但对齐
    // 契约仍被调试快照（monitoring 按 index 回绑元数据）等消费者依赖，必须守住。
    const history: MessageInfo[] = [
      message({ id: "user-task", seq: 1, role: "user", content_parts: [{ type: "text", text: "task" }], metadata: {} }),
      message({
        id: "intent-parallel",
        seq: 2,
        role: "assistant",
        metadata: { msg_type: MSG_TYPE.ROUND },
        tool_calls: [
          { id: "call-1", type: "function" as const, function: { name: "task_output", arguments: "{}" } },
          { id: "call-2", type: "function" as const, function: { name: "list_child_agents", arguments: "{}" } },
        ],
      }),
      message({
        id: "observation-2",
        seq: 3,
        role: "tool",
        content_parts: [{ type: "text", text: "result 2" }],
        metadata: { msg_type: MSG_TYPE.OBSERVATION },
        tool_call_id: "call-2",
        name: "list_child_agents",
      }),
      message({
        id: "claimed-agent-result",
        seq: 4,
        role: "user",
        content_parts: [{ type: "text", text: "[agent-message kind=result]" }],
        // ui_context 扩展投影夹具：默认注册表会把它渲染成 <ui_context> 文本块追加到
        // content——等价性断言由此覆盖"交付物与首次请求同形（扩展投影一致）"的主张。
        metadata: {
          agent_message: true,
          extensions: [{ kind: "ui_context", data: { entries: [{ label: "页面", value: "工作台", detail: "冒烟测试" }] } }],
        },
      }),
    ];
    const historyPort: ConversationHistoryPort = {
      getRecentMessages: vi.fn(async () => history),
    } as ConversationHistoryPort;
    const source = new RecentMessagesContextSource(historyPort, false, createDefaultProjectionRegistry());
    const result = await source.build({ sessionId: "session-1", threadKey: "root", cacheAlive: false, touch: false });

    const conversation = result.conversation ?? [];
    // 合成结果插入在 assistant 之后，长度与 originals 严格相等（对齐不变量）。
    expect(conversation.length).toBe(result.rawMessages!.length);
    expect(conversation.map((entry) => entry.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);

    // 复刻按索引识别投递物的消费方式（修复后应正确选中 user 消息本身）。
    const acceptedIds = new Set(["claimed-agent-result"]);
    const delivered = conversation.flatMap((entry, index) => {
      const raw = result.rawMessages![index];
      return raw?.role === "user" && acceptedIds.has(raw.id) ? [entry] : [];
    });
    // 必须投递 user 消息本身——而不是错位后对上的真实 tool 消息（回归点）。
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.role).toBe("user");
    expect(String(delivered[0]!.content)).toContain("[agent-message kind=result]");

    // refresh 投递现路径（projectRows）在同样的失败形状上必须交付等价物——
    // 只依赖被认领的行本身，与全量视图的几何（含孤儿补齐）完全解耦；
    // 且扩展投影（ui_context）在两条路径上一致生效。
    const projected = await source.projectRows(
      history.filter((row) => row.id === "claimed-agent-result"),
      { sessionId: "session-1", threadKey: "root", cacheAlive: false, touch: false },
    );
    expect(String(delivered[0]!.content)).toContain("<ui_context>");
    expect(projected).toEqual(delivered);
  });

  it("projectRows applies the same visibility filter as the full build", async () => {
    const source = new RecentMessagesContextSource(
      { getRecentMessages: vi.fn(async () => []) } as unknown as ConversationHistoryPort,
      false,
      new ProjectionRegistry(),
    );
    const rows: MessageInfo[] = [
      message({ id: "claimed", seq: 1, role: "user", content_parts: [{ type: "text", text: "claimed input" }], metadata: {} }),
      message({ id: "hidden-claimed", seq: 2, role: "user", content_parts: [{ type: "text", text: "hidden" }], metadata: { hidden: true } }),
      message({ id: "display-only", seq: 3, role: "user", content_parts: [{ type: "text", text: "ui only" }], metadata: { display_only: true } }),
    ];
    const projected = await source.projectRows(rows, { sessionId: "session-1", threadKey: "root", cacheAlive: false, touch: false });

    expect(projected).toHaveLength(1);
    expect(projected[0]!.role).toBe("user");
    expect(String(projected[0]!.content)).toContain("claimed input");
  });
});
