import type { AgentProfile } from "@ragsystem/agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { AgentConfigSchema } from "../../src/contracts/agent-config.js";
import { buildBackendAgentContext } from "../../src/services/agent/context/backend-context-builder.js";

describe("backend context memory bindings", () => {
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
