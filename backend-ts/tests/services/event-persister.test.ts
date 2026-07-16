import { describe, expect, it } from "vitest";

import { KernelEventPersister, type PersisterRunContext } from "../../src/services/agent/sdk/event-persister.js";
import type { KernelEvent } from "@ragsystem/agent-sdk";
import type { ConversationStore } from "../../src/contracts/conversation-store/index.js";

interface MockStore {
  store: ConversationStore;
  addMessageCalls: Array<Record<string, unknown>>;
  updateRunStatusCalls: Array<[string, string, string, string | null]>;
  suspendPendingCalls: Array<[string, string]>;
  continuationWrites: Array<Record<string, unknown>>;
  continuationDeletes: Array<[string, string]>;
}

/** 最小 store mock：只实现当前测试路径用到的事务方法。 */
function mockStore(): MockStore {
  const addMessageCalls: Array<Record<string, unknown>> = [];
  const updateRunStatusCalls: Array<[string, string, string, string | null]> = [];
  const suspendPendingCalls: Array<[string, string]> = [];
  const continuationWrites: Array<Record<string, unknown>> = [];
  const continuationDeletes: Array<[string, string]> = [];
  type MockTransaction = {
    addMessage: (input: Record<string, unknown>) => { id: string; seq: number };
    updateRunStatus: (runId: string, sessionId: string, status: string, finalMessageId: string | null) => boolean;
    suspendPendingInteractions: (sessionId: string, rootRunId: string) => number;
    putProviderContinuation: (input: Record<string, unknown>) => Record<string, unknown>;
    deleteProviderContinuations: (sessionId: string, threadKey: string) => number;
  };
  const tx: MockTransaction = {
    addMessage: (input: Record<string, unknown>) => {
      addMessageCalls.push(input);
      return { id: `m${addMessageCalls.length}`, seq: addMessageCalls.length };
    },
    updateRunStatus: (runId, sessionId, status, finalMessageId) => {
      updateRunStatusCalls.push([runId, sessionId, status, finalMessageId]);
      return true;
    },
    suspendPendingInteractions: (sessionId, rootRunId) => {
      suspendPendingCalls.push([sessionId, rootRunId]);
      return 1;
    },
    putProviderContinuation: (input) => {
      continuationWrites.push(input);
      return input;
    },
    deleteProviderContinuations: (sessionId, threadKey) => {
      continuationDeletes.push([sessionId, threadKey]);
      return 1;
    },
  };
  const store = {
    runInTransaction: (fn: (transaction: MockTransaction) => unknown): unknown => fn(tx),
  } as unknown as ConversationStore;
  return { store, addMessageCalls, updateRunStatusCalls, suspendPendingCalls, continuationWrites, continuationDeletes };
}

const ctx: PersisterRunContext = {
  sessionId: "s1",
  runId: "r1",
  threadKey: "root",
  agentName: "agent",
  agentDisplayName: "Agent",
  providerType: "anthropic",
  rootCallId: "c1",
  rootRunId: "r1",
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

  it("suspended 仅更新状态并保留悬空工具调用", () => {
    const { store, addMessageCalls, updateRunStatusCalls, suspendPendingCalls } = mockStore();
    const persister = new KernelEventPersister(store, ctx);

    persister.finalize("suspended", null);

    expect(addMessageCalls).toHaveLength(0);
    expect(suspendPendingCalls).toEqual([["s1", "r1"]]);
    expect(updateRunStatusCalls).toEqual([["r1", "s1", "suspended", null]]);
  });

  it("persists private continuation with the assistant tool message and replaces older state", () => {
    const { store, continuationWrites, continuationDeletes } = mockStore();
    const persister = new KernelEventPersister(store, ctx);
    persister.persist({
      type: "assistant_intermediate",
      agentName: "agent",
      round: 0,
      message: {
        role: "assistant",
        content: "lookup",
        tool_calls: [{ id: "t1", type: "function", function: { name: "search", arguments: "{}" } }],
        provider_continuation: {
          protocol: "anthropic_messages",
          toolCallIds: ["t1"],
          blocks: [{ type: "thinking", thinking: "private", signature: "sig" }],
        },
      },
    });

    expect(continuationDeletes).toEqual([["s1", "root"]]);
    expect(continuationWrites).toEqual([
      expect.objectContaining({ messageId: "m1", providerType: "anthropic", toolCallIds: ["t1"] }),
    ]);
    expect(JSON.stringify(continuationWrites[0])).toContain("signature");
  });
});
