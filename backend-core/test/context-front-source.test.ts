import { describe, expect, it } from "vitest";
import { AgentConfigSchema, type AgentConfig } from "../src/contracts/agent/agent-config.js";
import { createToolRegistry } from "@ragsystem/agent-sdk";
import type { SessionIdentity } from "../src/contracts/session/session.js";
import type { ModelProviderConfig } from "../src/contracts/integrations/model-adapter.js";
import { projectAgentProfile } from "../src/services/agent/sdk/projection.js";
import { buildBackendAgentContext } from "../src/services/agent/context/backend-context-builder.js";
import { previewBackendAgentContext } from "../src/services/agent/context/index.js";
import type {
  AgentContextSource,
  ConversationHistoryPort,
  ResolvedAgentContextRequest,
  SessionMetadataPort,
} from "../src/services/agent/context/types.js";
import type { BackendContextSourceFactory } from "../src/plugins/backend-plugin.js";
import type { ChatMessage } from "@ragsystem/agent-llm";
import { createTestTeamSnapshot } from "./session-team-fixture.js";

const agent = AgentConfigSchema.parse({
  agent_name: "test-agent",
  display_name: "Test Agent",
  llm_tiers: { default: { provider: "provider", model_name: "model" } },
});

const provider: ModelProviderConfig = {
  name: "provider",
  provider_type: "test",
  api_key: "test-key",
  models: [{ name: "model" }],
};

const profile = projectAgentProfile({ agent, providers: [provider] });

function identity(): SessionIdentity {
  return {
    sessionId: "session-1",
    ownerUserId: null,
    visibility: "private",
    originType: "direct",
    originId: null,
    originChannel: "api",
    workspaceId: null,
    teamSnapshot: createTestTeamSnapshot("test-agent", [agent]),
    metadata: {},
    permissionMode: null,
  };
}

function historyPort(): ConversationHistoryPort & SessionMetadataPort {
  return {
    getRecentMessages: async () => [
      {
        id: "msg-1",
        seq: 1,
        session_id: "session-1",
        role: "user",
        content_parts: [{ type: "text", text: "recent message" }],
        metadata: {},
        created_at: "2026-08-31T00:00:00.000Z",
        thread_key: "root",
        child_agent_id: null,
      },
    ],
    getSession: () => ({ metadata: {} }),
  };
}

/** SessionMetadataPort 写读一致的 fake：ProviderCacheTracker touch 后 isAlive 可回读。 */
function metadataPort(): ConversationHistoryPort & SessionMetadataPort {
  let metadata: Record<string, unknown> = {};
  return {
    getRecentMessages: async () => [],
    getSession: () => ({ metadata }),
    updateSessionMetadata: (_sessionId, patch) => {
      metadata = { ...metadata, ...patch };
      return metadata;
    },
  };
}

function frontSource(content: string): AgentContextSource {
  return {
    name: "front",
    build: async () => ({ conversation: [{ role: "system", content }] }),
  };
}

describe("front context sources (plugin extension point)", () => {
  it("places front source messages before history and drops null factories", async () => {
    const ctx = await buildBackendAgentContext(agent, profile, historyPort(), {
      dataRoot: "/tmp/none",
      sessionId: "session-1",
      threadKey: "root",
      sessionIdentity: identity(),
      frontContextSources: [
        () => frontSource("front-block"),
        () => null,
      ],
    });
    expect(ctx.built.conversation).toEqual<ChatMessage[]>([
      { role: "system", content: "front-block" },
      { role: "user", content: "recent message" },
    ]);
  });

  it("forwards cacheAlive state to front sources (cold first, alive after touch)", async () => {
    const received: boolean[] = [];
    const frontFactory: BackendContextSourceFactory = () => ({
      name: "front",
      build: async (request: ResolvedAgentContextRequest) => {
        received.push(request.cacheAlive);
        return { conversation: [] };
      },
    });
    const ctx = await buildBackendAgentContext(agent, profile, metadataPort(), {
      dataRoot: "/tmp/none",
      sessionId: "session-1",
      threadKey: "root",
      sessionIdentity: identity(),
      frontContextSources: [frontFactory],
    });
    // 首次组装：tracker 无 last_used_at → cacheAlive=false；touch 后活跃。
    await ctx.contextBuilder.buildContext(
      { sessionId: "session-1", threadKey: "root" },
      { touch: true },
    );
    expect(received).toEqual([false, true]);
  });

  it("skips front factories when session identity is absent", async () => {
    let calls = 0;
    const frontFactory: BackendContextSourceFactory = async () => {
      calls += 1;
      return frontSource("front-block");
    };
    await buildBackendAgentContext(agent, profile, historyPort(), {
      dataRoot: "/tmp/none",
      sessionId: "session-1",
      threadKey: "root",
      frontContextSources: [frontFactory],
    });
    expect(calls).toBe(0);
  });

  it("preview assembles front sources before history and stays read-only", async () => {
    const touches: boolean[] = [];
    const frontFactory: BackendContextSourceFactory = () => ({
      name: "front",
      build: async (request: ResolvedAgentContextRequest) => {
        touches.push(request.touch);
        return { conversation: [{ role: "system", content: "front-block" }] };
      },
    });
    const snapshot = await previewBackendAgentContext(
      agent,
      profile,
      historyPort(),
      createToolRegistry({ tools: [] }),
      {
        dataRoot: "/tmp/none",
        sessionId: "session-1",
        threadKey: "root",
        sessionIdentity: identity(),
        frontContextSources: [frontFactory],
      },
    );
    expect(snapshot.built.conversation).toEqual<ChatMessage[]>([
      { role: "system", content: "front-block" },
      { role: "user", content: "recent message" },
    ]);
    expect(snapshot.preview.request.messages.length).toBeGreaterThan(0);
    // 预览（monitoring 快照）按契约只读：不续期、不触发 source 写副作用。
    expect(touches).toEqual([false]);
  });
});
