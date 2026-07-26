import { describe, expect, it } from "vitest";

import { LocalAgentDelegationStoreAdapter } from "../../../src/adapters/local/local-agent-delegation-store-adapter.js";
import { LocalAgentMetricsStoreAdapter } from "../../../src/adapters/local/local-agent-metrics-store-adapter.js";
import { createConversationStore } from "../../../src/adapters/local/sqlite/conversation-store/index.js";
import { LOCAL_TENANT_ID } from "../../../src/services/identity/index.js";

describe("Local core runtime store adapters", () => {
  it("exposes delegation persistence through Promise-only methods", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      store.createSession({ tenantId: LOCAL_TENANT_ID, sessionId: "delegation-adapter", ownerUserId: "usr_system", visibility: "tenant", originType: "direct", originId: null, originChannel: "api", workspaceId: null });
      const adapter = new LocalAgentDelegationStoreAdapter(store);
      const message = adapter.addMessage({
        sessionId: "delegation-adapter",
        role: "user",
        content: "delegate",
      });

      expect(message).toBeInstanceOf(Promise);
      await expect(message).resolves.toMatchObject({ content: "delegate" });
      await expect(adapter.getRecentMessages("delegation-adapter", 1, "root"))
        .resolves.toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("exposes metric persistence through Promise-only methods", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      const adapter = new LocalAgentMetricsStoreAdapter(store);
      const inserted = adapter.insertMetric({
        agentName: "metrics-adapter",
        executionKind: "test",
        status: "completed",
        durationMs: 10,
        startedAt: "2026-01-01T00:00:00.000Z",
      });

      expect(inserted).toBeInstanceOf(Promise);
      await inserted;
      await expect(adapter.aggregateMetrics("metrics-adapter")).resolves.toEqual([
        expect.objectContaining({ agent_name: "metrics-adapter", total_calls: 1 }),
      ]);
    } finally {
      store.close();
    }
  });
});
