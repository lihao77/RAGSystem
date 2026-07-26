import { describe, expect, it, vi } from "vitest";

import { RecentMessagesContextSource } from "../../src/services/agent/context/recent-messages-source.js";
import { ProjectionRegistry } from "../../src/services/agent/context/extensions/index.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";

const continuation = {
  protocol: "anthropic_messages" as const,
  toolCallIds: ["tool-1"],
  blocks: [{ type: "thinking" as const, thinking: "private", signature: "sig" }],
};

describe("provider continuation persistence", () => {
  it("stores continuation outside public message metadata", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    createSession(store);
    const message = store.addMessage({
      sessionId: "s1",
      role: "assistant",
      content: "working",
      threadKey: "root",
      toolCalls: [{ id: "tool-1", type: "function", function: { name: "search", arguments: "{}" } }],
    });
    store.putProviderContinuation({
      messageId: message.id,
      sessionId: "s1",
      threadKey: "root",
      providerType: "anthropic",
      toolCallIds: ["tool-1"],
      state: continuation,
    });

    expect(store.getProviderContinuation("s1", message.id)?.state).toEqual(continuation);
    const publicMessage = store.getMessageById("s1", message.id)!;
    expect(JSON.stringify(publicMessage.metadata)).not.toContain("private");
    expect(JSON.stringify(publicMessage.metadata)).not.toContain("signature");
    expect(store.deleteProviderContinuations("s1", "root")).toBe(1);
    expect(store.getProviderContinuation("s1", message.id)).toBeNull();
    store.close();
  });

  it("restores state only when its assistant tool call is the active history tail", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    createSession(store);
    store.addMessage({ sessionId: "s1", role: "user", content: "search", threadKey: "root" });
    const assistant = store.addMessage({
      sessionId: "s1",
      role: "assistant",
      content: "working",
      threadKey: "root",
      toolCalls: [{ id: "tool-1", type: "function", function: { name: "search", arguments: "{}" } }],
    });
    store.putProviderContinuation({
      messageId: assistant.id,
      sessionId: "s1",
      threadKey: "root",
      providerType: "anthropic",
      toolCallIds: ["tool-1"],
      state: continuation,
    });
    const source = new RecentMessagesContextSource({
      getRecentMessages: async (sessionId, limit, threadKey) => store.getRecentMessages(sessionId, limit, threadKey),
      getProviderContinuation: async (sessionId, messageId) => store.getProviderContinuation(sessionId, messageId),
    }, false, new ProjectionRegistry());
    const pending = await source.build(request());
    expect(pending.conversation?.[1]?.provider_continuation).toEqual(continuation);

    store.addMessage({ sessionId: "s1", role: "user", content: "new task", threadKey: "root" });
    const newTurn = await source.build(request());
    expect(newTurn.conversation?.some((message) => message.provider_continuation !== undefined)).toBe(false);
    store.close();
  });

  it("awaits an asynchronous private continuation lookup", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    createSession(store);
    store.addMessage({ sessionId: "s1", role: "user", content: "search", threadKey: "root" });
    const assistant = store.addMessage({
      sessionId: "s1",
      role: "assistant",
      content: "working",
      threadKey: "root",
      toolCalls: [{ id: "tool-1", type: "function", function: { name: "search", arguments: "{}" } }],
    });
    const lookup = vi.fn().mockResolvedValue({ state: continuation });
    const source = new RecentMessagesContextSource({
      getRecentMessages: async (sessionId, limit, threadKey) => store.getRecentMessages(sessionId, limit, threadKey),
      getProviderContinuation: lookup,
    }, false, new ProjectionRegistry());

    const built = await source.build(request());

    expect(lookup).toHaveBeenCalledWith("s1", assistant.id);
    expect(built.conversation?.[1]?.provider_continuation).toEqual(continuation);
    store.close();
  });
});

function createSession(store: ReturnType<typeof createConversationStore>): void {
  store.createSession({
    tenantId: LOCAL_TENANT_ID,
    sessionId: "s1",
    ownerUserId: "usr_local",
    visibility: "private",
    originType: "direct",
    originId: null,
    originChannel: "web",
    workspaceId: null,
  });
}

function request() {
  return {
    sessionId: "s1",
    threadKey: "root",
    microcompact: false,
    microcompactKeepRecentTools: 5,
    cacheAlive: false,
    touch: false,
  };
}
