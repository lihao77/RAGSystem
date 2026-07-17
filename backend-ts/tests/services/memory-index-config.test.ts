import { describe, expect, it, vi } from "vitest";

import { SystemConfigService } from "../../src/services/config/system-config-service.js";
import {
  buildMemoryIndexContextSourceOptions,
  MemoryIndexContextSource,
} from "../../src/services/agent/memory/memory-index-source.js";
import type { IMemoryStore } from "../../src/contracts/memory-store/index.js";

describe("memory index system config assembly", () => {
  it("passes configured index limits through to loadIndexHead", () => {
    const systemConfig = new SystemConfigService({ configPath: "" });
    systemConfig.updateConfig({ memory: { index_max_lines: 50, index_max_chars: 6400 } });
    const loadIndexHead = vi.fn(() => "# Session Memory");
    const memoryStore = { loadIndexHead } as unknown as IMemoryStore;
    const source = new MemoryIndexContextSource(
      { getSession: () => ({ metadata: {} }), updateSessionMetadata: () => null },
      { auto_inject: true, allowed_scopes: ["session"], write_scopes: [], archive_scopes: [] },
      "agent",
      { ...buildMemoryIndexContextSourceOptions(systemConfig.getMemoryConfig(), "."), memoryStore },
    );

    source.build({
      sessionId: "session",
      threadKey: "root",
      microcompact: false,
      microcompactKeepRecentTools: 5,
      cacheAlive: false,
      touch: false,
    });

    expect(loadIndexHead).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "session", session_id: "session" }),
      { maxLines: 50, maxChars: 6400 },
    );
  });

  it("injects only the current user's private team candidates", () => {
    const source = new MemoryIndexContextSource(
      {
        getSession: () => ({ metadata: { team: "default" }, user_id: "usr_alice" }),
        listMemoryCandidates: (input) => input.ownerUserId === "usr_alice"
          ? [{
              id: "candidate-1",
              tenant_id: "tnt_alpha",
              owner_user_id: "usr_alice",
              target_scope: "team",
              operation: "publish",
              target_file_name: null,
              team_name: "default",
              agent_name: null,
              name: "Alice preference",
              description: "personal team behavior",
              memory_type: "preference",
              content: "Use concise summaries.",
              why: null,
              how_to_apply: null,
              status: "candidate",
              source_session_id: null,
              source_run_id: null,
              source_message_id: null,
              reviewer_user_id: null,
              review_comment: null,
              published_file_name: null,
              created_at: "2026-07-17T00:00:00Z",
              updated_at: "2026-07-17T00:00:00Z",
              reviewed_at: null,
              review_claimed_at: null,
              review_attempt_id: null,
            }]
          : [],
      },
      { auto_inject: true, allowed_scopes: ["team"], write_scopes: ["team"], archive_scopes: [] },
      "agent",
      { memoryStore: { loadIndexHead: () => "" } as unknown as IMemoryStore },
    );

    const result = source.build({
      sessionId: "session",
      threadKey: "root",
      microcompact: false,
      microcompactKeepRecentTools: 5,
      cacheAlive: false,
      touch: false,
    });

    expect(result.conversation?.[0]?.content).toContain("Alice preference");
    expect(result.conversation?.[0]?.content).toContain("Use concise summaries.");
    expect(result.conversation?.[0]?.content).not.toContain("candidate");
    const fingerprint = (result.metadata?.snapshot as { fingerprint: { private_candidate_revision: string } }).fingerprint;
    expect(fingerprint.private_candidate_revision).toMatch(/^[a-f0-9]{24}$/);
  });

  it("prioritizes agent candidates over team candidates within the shared character budget", () => {
    const records = (scope: "team" | "agent") => [{
      id: scope,
      tenant_id: "tnt_alpha",
      owner_user_id: "usr_alice",
      target_scope: scope,
      operation: "publish" as const,
      target_file_name: null,
      team_name: "default",
      agent_name: scope === "agent" ? "agent" : null,
      name: scope === "agent" ? "Important agent memory" : "Large team memory",
      description: scope,
      memory_type: "fact",
      content: scope === "team" ? "T".repeat(25_000) : "agent-specific-content",
      why: null, how_to_apply: null, status: "candidate" as const,
      source_session_id: null, source_run_id: null, source_message_id: null,
      reviewer_user_id: null, review_comment: null, published_file_name: null,
      created_at: "2026-07-17T00:00:00Z", updated_at: "2026-07-17T00:00:00Z", reviewed_at: null, review_claimed_at: null, review_attempt_id: null,
    }];
    const source = new MemoryIndexContextSource(
      {
        getSession: () => ({ metadata: { team: "default" }, user_id: "usr_alice" }),
        listMemoryCandidates: (input) => records(input.targetScope as "team" | "agent"),
      },
      { auto_inject: true, allowed_scopes: ["team", "agent"], write_scopes: [], archive_scopes: [] },
      "agent",
      { memoryStore: { loadIndexHead: () => "" } as unknown as IMemoryStore },
    );
    const result = source.build({ sessionId: "s1", threadKey: "root", microcompact: false, microcompactKeepRecentTools: 5, cacheAlive: false, touch: false });
    expect(result.conversation?.[0]?.content).toContain("agent-specific-content");
  });
});
