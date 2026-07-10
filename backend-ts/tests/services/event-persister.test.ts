import { describe, expect, it } from "vitest";

import { KernelEventPersister, type PersisterRunContext } from "../../src/services/agent/sdk/event-persister.js";
import type { KernelEvent } from "@ragsystem/agent-sdk";
import type { ConversationStore } from "../../src/contracts/conversation-store/index.js";

interface MockStore {
  store: ConversationStore;
  addMessageCalls: Array<Record<string, unknown>>;
}

/** 最小 store mock：只实现 persist 路径用到的 runInTransaction + tx.addMessage。 */
function mockStore(): MockStore {
  const addMessageCalls: Array<Record<string, unknown>> = [];
  type MockTransaction = {
    addMessage: (input: Record<string, unknown>) => { id: string; seq: number };
  };
  const tx: MockTransaction = {
    addMessage: (input: Record<string, unknown>) => {
      addMessageCalls.push(input);
      return { id: `m${addMessageCalls.length}`, seq: addMessageCalls.length };
    },
  };
  const store = {
    runInTransaction: (fn: (transaction: MockTransaction) => unknown): unknown => fn(tx),
  } as unknown as ConversationStore;
  return { store, addMessageCalls };
}

const ctx: PersisterRunContext = {
  sessionId: "s1",
  runId: "r1",
  threadKey: "root",
  agentName: "agent",
  agentDisplayName: "Agent",
  rootCallId: "c1",
  parentCallId: null,
};

describe("KernelEventPersister — 工具消息持久化", () => {
  it("tool_call 不在 persister 重复归档", () => {
    const { store, addMessageCalls } = mockStore();
    const persister = new KernelEventPersister(store, ctx);
    const event: KernelEvent = {
      type: "tool_call",
      agentName: "agent",
      toolCallId: "t1",
      toolName: "search",
      arguments: { q: "x" },
      round: 0,
      order: 1,
      roundIndex: 1,
    };
    persister.persist(event);
    expect(addMessageCalls).toHaveLength(0);
  });

  it("tool_result 只落 observation message", () => {
    const { store, addMessageCalls } = mockStore();
    const persister = new KernelEventPersister(store, ctx);
    const event: KernelEvent = {
      type: "tool_result",
      agentName: "agent",
      toolCallId: "t1",
      toolName: "search",
      success: true,
      summary: "ok",
      observation: "搜索结果",
      metadata: {},
      elapsedTime: 0.12,
      round: 0,
      order: 1,
      roundIndex: 1,
    };
    persister.persist(event);
    expect(addMessageCalls).toHaveLength(1);
    const msg = addMessageCalls[0]!;
    expect(msg.role).toBe("tool");
    expect(msg.content).toBe("搜索结果");
    expect(msg.toolCallId).toBe("t1");
    expect(msg.name).toBe("search");
    expect((msg.metadata as Record<string, unknown>).msg_type).toBe("observation");
  });

  it("persists tool media as file-reference extensions without base64", () => {
    const { store, addMessageCalls } = mockStore();
    const persister = new KernelEventPersister(store, ctx);
    persister.persist({
      type: "tool_result",
      agentName: "agent",
      toolCallId: "t-image",
      toolName: "screenshot",
      success: true,
      summary: "ok",
      observation: "截图完成",
      metadata: {
        tool_result_media: [{ kind: "image", stored_path: "/managed/image.png", mime: "image/png" }],
      },
      elapsedTime: 0.1,
      round: 0,
      order: 1,
      roundIndex: 1,
    });

    expect(addMessageCalls[0]?.metadata).toMatchObject({
      extensions: [{ kind: "tool_result_media", data: { media: [{ stored_path: "/managed/image.png" }] } }],
    });
    expect(JSON.stringify(addMessageCalls[0])).not.toContain("base64");
  });
});
