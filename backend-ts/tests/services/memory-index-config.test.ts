import { describe, expect, it, vi } from "vitest";

import { SystemConfigService } from "../../src/services/config/system-config-service.js";
import {
  MemoryContextSource,
} from "../../src/services/agent/memory/memory-context-source.js";
import { buildMemoryContextSourceOptions } from "../../src/adapters/local/memory-context-options.js";
import { LocalMemoryContextRepository } from "../../src/adapters/local/local-memory-context-repository.js";
import type { MemoryContextRepository } from "../../src/contracts/memory-store/index.js";

describe("memory index system config assembly", () => {
  it("passes configured index limits through to loadIndexHead", async () => {
    const systemConfig = new SystemConfigService({
      load: async () => null,
      save: async () => undefined,
    });
    await systemConfig.initialize();
    await systemConfig.updateConfig({ memory: { index_max_lines: 50, index_max_chars: 6400 } });
    const loadIndexHead = vi.fn(() => "# Session Memory");
    const memoryStore = { loadIndexHead };
    const source = new MemoryContextSource(
      { getSession: () => ({ metadata: {} }), updateSessionMetadata: () => null },
      new LocalMemoryContextRepository(memoryStore),
      { auto_inject: true, allowed_scopes: ["session"], write_scopes: [], archive_scopes: [] },
      "agent",
      buildMemoryContextSourceOptions(systemConfig.getMemoryConfig(), "."),
    );

    await source.build({
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

  it("injects only the current user's private team candidates", async () => {
    const source = new MemoryContextSource(
      {
        getSession: () => ({ metadata: { team: "default" }, user_id: "usr_alice" }),
        listMemoryCandidates: async (input) => input.ownerUserId === "usr_alice"
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
      emptyRepository(),
      { auto_inject: true, allowed_scopes: ["team"], write_scopes: ["team"], archive_scopes: [] },
      "agent",
    );

    const result = await source.build({
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

  it("prioritizes agent candidates over team candidates within the shared character budget", async () => {
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
    const source = new MemoryContextSource(
      {
        getSession: () => ({ metadata: { team: "default" }, user_id: "usr_alice" }),
        listMemoryCandidates: async (input) => records(input.targetScope as "team" | "agent"),
      },
      emptyRepository(),
      { auto_inject: true, allowed_scopes: ["team", "agent"], write_scopes: [], archive_scopes: [] },
      "agent",
    );
    const result = await source.build({ sessionId: "s1", threadKey: "root", microcompact: false, microcompactKeepRecentTools: 5, cacheAlive: false, touch: false });
    expect(result.conversation?.[0]?.content).toContain("agent-specific-content");
  });

  it("defers private candidate changes until the cache epoch expires", async () => {
    let metadata: Record<string, unknown> = {};
    let content = "first candidate";
    const listMemoryCandidates = vi.fn(async () => [{
      id: "candidate-1",
      tenant_id: "tenant",
      owner_user_id: "user",
      target_scope: "team" as const,
      operation: "publish" as const,
      target_file_name: null,
      team_name: "default",
      agent_name: null,
      name: "Preference",
      description: "Personal preference",
      memory_type: "preference",
      content,
      why: null,
      how_to_apply: null,
      status: "candidate" as const,
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
    }]);
    const source = new MemoryContextSource(
      {
        getSession: () => ({ metadata, user_id: "user" }),
        updateSessionMetadata: (_sessionId, patch) => {
          metadata = { ...metadata, ...patch };
          return metadata;
        },
        listMemoryCandidates,
      },
      emptyRepository(),
      { auto_inject: true, allowed_scopes: ["team"], write_scopes: [], archive_scopes: [] },
      "agent",
    );
    metadata = { ...metadata, team: "default" };
    const request = { sessionId: "session", threadKey: "root", microcompact: false, microcompactKeepRecentTools: 5, cacheAlive: true, touch: false };

    const first = await source.build(request);
    content = "second candidate";
    const cached = await source.build(request);
    const refreshed = await source.build({ ...request, cacheAlive: false });

    expect(first.conversation?.[0]?.content).toContain("first candidate");
    expect(cached.conversation?.[0]?.content).toContain("first candidate");
    expect(refreshed.conversation?.[0]?.content).toContain("second candidate");
    expect(listMemoryCandidates).toHaveBeenCalledTimes(2);
  });

  it("keeps an active provider-cache snapshot stable until the cache expires", async () => {
    let metadata: Record<string, unknown> = {};
    let revision = 1;
    let index = "first index";
    const loadIndexHead = vi.fn(() => index);
    const source = new MemoryContextSource(
      {
        getSession: () => ({ metadata }),
        updateSessionMetadata: (_sessionId, patch) => {
          metadata = { ...metadata, ...patch };
          return null;
        },
      },
      {
        resolveWorkspaceKey: async () => null,
        loadIndex: async () => loadIndexHead(),
        getScopeRevision: async () => revision,
      },
      { auto_inject: true, allowed_scopes: ["session"], write_scopes: [], archive_scopes: [] },
      "agent",
    );
    const request = { sessionId: "session", threadKey: "root", microcompact: false, microcompactKeepRecentTools: 5, cacheAlive: true, touch: false };

    const first = await source.build(request);
    index = "second index";
    revision = 2;
    const second = await source.build(request);
    const refreshed = await source.build({ ...request, cacheAlive: false });

    expect(first.conversation?.[0]?.content).toContain("first index");
    expect(second.conversation?.[0]?.content).toContain("first index");
    expect(refreshed.conversation?.[0]?.content).toContain("second index");
    expect(loadIndexHead).toHaveBeenCalledTimes(2);
    expect((refreshed.metadata?.snapshot as { fingerprint: { scope_revisions: unknown[] } }).fingerprint.scope_revisions).toEqual([
      { scope_name: "session", scope_spec: { scope: "session", session_id: "session" }, revision: "2" },
    ]);
  });

  it("preserves active provider-cache reuse when no scope revision reader is configured", async () => {
    let metadata: Record<string, unknown> = {};
    let index = "first index";
    const loadIndexHead = vi.fn(() => index);
    const source = new MemoryContextSource(
      {
        getSession: () => ({ metadata }),
        updateSessionMetadata: (_sessionId, patch) => {
          metadata = { ...metadata, ...patch };
          return null;
        },
      },
      {
        resolveWorkspaceKey: async () => null,
        loadIndex: async () => loadIndexHead(),
        getScopeRevision: async () => null,
      },
      { auto_inject: true, allowed_scopes: ["session"], write_scopes: [], archive_scopes: [] },
      "agent",
    );
    const request = { sessionId: "session", threadKey: "root", microcompact: false, microcompactKeepRecentTools: 5, cacheAlive: true, touch: false };

    const first = await source.build(request);
    index = "second index";
    const second = await source.build(request);

    expect(first.conversation?.[0]?.content).toContain("first index");
    expect(second.conversation?.[0]?.content).toContain("first index");
    expect(loadIndexHead).toHaveBeenCalledTimes(1);
    expect((second.metadata?.snapshot as { fingerprint: Record<string, unknown> }).fingerprint).not.toHaveProperty("scope_revisions");
  });
});

function emptyRepository(): MemoryContextRepository {
  return {
    resolveWorkspaceKey: async () => null,
    loadIndex: async () => "",
    getScopeRevision: async () => null,
  };
}
