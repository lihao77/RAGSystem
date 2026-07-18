import type { AgentProfile } from "@ragsystem/agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { AgentConfigSchema } from "../../src/contracts/agent-config.js";
import { buildBackendAgentContext } from "../../src/services/agent/context/backend-context-builder.js";

describe("backend context memory bindings", () => {
  it("awaits an asynchronous SaaS conversation history reader", async () => {
    const agent = AgentConfigSchema.parse({
      agent_name: "assistant",
      memory: { auto_inject: false, allowed_scopes: [], write_scopes: [], archive_scopes: [] },
    });
    const getRecentMessages = vi.fn(async () => [{
      id: "message-1",
      seq: 1,
      session_id: "session-1",
      role: "user" as const,
      content: "postgres history",
      metadata: {},
      thread_key: "root",
      child_agent_id: null,
      created_at: new Date(0).toISOString(),
    }]);

    const result = await buildBackendAgentContext(
      agent,
      { llmTiers: { default: { provider: { supports_vision: false } } } } as unknown as AgentProfile,
      {
        getRecentMessages,
        getSession: () => ({ metadata: {}, user_id: "usr_alpha" }),
      },
      {
        memoryConfig: { index_max_lines: 10, index_max_chars: 1000 },
        dataRoot: ".",
        sessionId: "session-1",
      },
    );

    expect(getRecentMessages).toHaveBeenCalledWith("session-1", 10_000, "root");
    expect(result.built.conversation).toContainEqual({ role: "user", content: "postgres history" });
  });

  it("uses the deployment-provided memory context source", async () => {
    const agent = AgentConfigSchema.parse({
      agent_name: "assistant",
      memory: { auto_inject: true, allowed_scopes: ["session"] },
    });
    const createMemoryContextSource = vi.fn(() => ({
      name: "memory",
      build: async () => ({ conversation: [{ role: "system" as const, content: "postgres memory" }] }),
    }));
    const history = {
      getRecentMessages: () => [],
      getSession: () => ({ metadata: {}, user_id: "usr_alpha" }),
      updateSessionMetadata: () => ({}),
    };

    const result = await buildBackendAgentContext(
      agent,
      { llmTiers: { default: { provider: { supports_vision: false } } } } as unknown as AgentProfile,
      history,
      {
        memoryConfig: { index_max_lines: 10, index_max_chars: 1000 },
        dataRoot: ".",
        sessionId: "session-1",
        memoryContextSourceFactory: createMemoryContextSource,
      },
    );

    expect(createMemoryContextSource).toHaveBeenCalledWith(expect.objectContaining({
      sessions: history,
      agentName: "assistant",
      memory: agent.memory,
    }));
    expect(result.built.conversation).toContainEqual({ role: "system", content: "postgres memory" });
  });
});
