import { describe, expect, it, vi } from "vitest";

import type { PersistedMemoryEntry } from "../../src/contracts/memory-store/index.js";
import { MemoryContextSource } from "../../src/services/agent/memory/memory-context-source.js";
import {
  renderPersistedMemoryIndex,
  SaaSMemoryContextRepository,
} from "../../src/adapters/saas/memory/saas-memory-context-repository.js";
import type { MemoryQueryService } from "../../src/services/memory/query-service.js";
import { toMemoryScopePartition } from "../../src/services/memory/scope-partition.js";
import type { MemoryScopePartition } from "../../src/services/memory/types.js";

const request = {
  sessionId: "session-1",
  threadKey: "root",
  microcompact: false,
  microcompactKeepRecentTools: 5,
  cacheAlive: true,
  touch: false,
};

function entry(overrides: Partial<PersistedMemoryEntry> = {}): PersistedMemoryEntry {
  return {
    tenant_id: "tenant-1",
    scope: "session",
    scope_id: "session-1",
    id: "memory-1",
    name: "Concise answers",
    description: "Keep summaries short.",
    memory_type: "preference",
    content: "This body is loaded only by an explicit read.",
    why: null,
    how_to_apply: null,
    status: "active",
    source_run_id: null,
    source_message_id: null,
    version: 1,
    created_at: "2026-07-18T00:00:00Z",
    updated_at: "2026-07-18T00:00:00Z",
    archived_at: null,
    ...overrides,
  };
}

describe("MemoryContextSource with the SaaS repository", () => {
  it("maps allowed scopes to tenant-bound query partitions", async () => {
    const listEntries = vi.fn(async (_partition: MemoryScopePartition) => [entry()]);
    const getScopeRevision = vi.fn(async (_partition: MemoryScopePartition) => 4);
    const query = { listEntries, getScopeRevision, getEntry: vi.fn(), listManagedEntries: vi.fn(), countManagedEntries: vi.fn() } satisfies MemoryQueryService;
    const source = new MemoryContextSource(
      {
        getSession: () => ({
          metadata: { team: "team-a", workspace_id: "workspace-a" },
          user_id: "user-a",
        }),
      },
      new SaaSMemoryContextRepository(query),
      {
        auto_inject: true,
        allowed_scopes: ["team", "session", "agent", "workspace", "user"],
        write_scopes: [],
        archive_scopes: [],
      },
      "agent-a",
    );

    const result = await source.build(request);

    expect(getScopeRevision.mock.calls.map(([partition]) => partition)).toEqual([
      { scope: "team", scope_id: "team-a" },
      { scope: "session", scope_id: "session-1" },
      { scope: "agent", scope_id: JSON.stringify(["team-a", "agent-a"]) },
      { scope: "workspace", scope_id: JSON.stringify(["user-a", "workspace-a"]) },
      { scope: "user", scope_id: "user-a" },
    ]);
    expect(listEntries).toHaveBeenCalledTimes(5);
    expect(result.conversation?.[0]?.content).toContain("memory_id: memory-1");
    expect(result.conversation?.[0]?.content).not.toContain("This body is loaded only by an explicit read.");
    expect(result.conversation?.[0]?.content).not.toContain("file_path");
  });

  it("keeps the snapshot stable for an active cache epoch and refreshes after expiry", async () => {
    let metadata: Record<string, unknown> = {};
    let revision = 1;
    let current = entry({ description: "first index" });
    const listEntries = vi.fn(async () => [current]);
    const query = {
      getEntry: vi.fn(),
      listEntries,
      getScopeRevision: vi.fn(async () => revision),
      listManagedEntries: vi.fn(),
      countManagedEntries: vi.fn(),
    } satisfies MemoryQueryService;
    const source = new MemoryContextSource(
      {
        getSession: () => ({ metadata }),
        updateSessionMetadata: (_sessionId, patch) => {
          metadata = { ...metadata, ...patch };
          return metadata;
        },
      },
      new SaaSMemoryContextRepository(query),
      { auto_inject: true, allowed_scopes: ["session"], write_scopes: [], archive_scopes: [] },
      "agent-a",
    );

    const first = await source.build(request);
    current = entry({ description: "visible after cache expiry" });
    const cached = await source.build(request);
    revision = 2;
    const stillCached = await source.build(request);
    const refreshed = await source.build({ ...request, cacheAlive: false });

    expect(first.conversation?.[0]?.content).toContain("first index");
    expect(cached.conversation?.[0]?.content).toContain("first index");
    expect(stillCached.conversation?.[0]?.content).toContain("first index");
    expect(refreshed.conversation?.[0]?.content).toContain("visible after cache expiry");
    expect(listEntries).toHaveBeenCalledTimes(2);
    expect(query.getScopeRevision).toHaveBeenCalledTimes(2);
  });

  it("rebuilds immediately when the memory structure changes", async () => {
    let metadata: Record<string, unknown> = {};
    const listEntries = vi.fn(async () => [entry()]);
    const query = {
      getEntry: vi.fn(),
      listEntries,
      getScopeRevision: vi.fn(async () => 1),
      listManagedEntries: vi.fn(),
      countManagedEntries: vi.fn(),
    } satisfies MemoryQueryService;
    const sessions = {
      getSession: () => ({ metadata }),
      updateSessionMetadata: (_sessionId: string, patch: Record<string, unknown>) => {
        metadata = { ...metadata, ...patch };
        return metadata;
      },
    };
    const repository = new SaaSMemoryContextRepository(query);
    const firstSource = new MemoryContextSource(
      sessions,
      repository,
      { auto_inject: true, allowed_scopes: ["session"], write_scopes: [], archive_scopes: [] },
      "agent-a",
    );
    const changedSource = new MemoryContextSource(
      sessions,
      repository,
      { auto_inject: true, allowed_scopes: ["session"], write_scopes: ["session"], archive_scopes: [] },
      "agent-a",
    );

    await firstSource.build(request);
    const rebuilt = await changedSource.build(request);

    expect(rebuilt.conversation?.[0]?.content).toContain("可写入 scope: session");
    expect(listEntries).toHaveBeenCalledTimes(2);
    expect(query.getScopeRevision).toHaveBeenCalledTimes(2);
  });

  it("does not query entries when auto injection is disabled", async () => {
    const query = {
      getEntry: vi.fn(),
      listEntries: vi.fn(async () => [entry()]),
      getScopeRevision: vi.fn(async () => 0),
      listManagedEntries: vi.fn(),
      countManagedEntries: vi.fn(),
    } satisfies MemoryQueryService;
    const source = new MemoryContextSource(
      { getSession: () => ({ metadata: {} }) },
      new SaaSMemoryContextRepository(query),
      { auto_inject: false, allowed_scopes: ["session"], write_scopes: [], archive_scopes: [] },
      "agent-a",
    );

    const result = await source.build({ ...request, cacheAlive: false });

    expect(query.listEntries).not.toHaveBeenCalled();
    expect(result.conversation?.[0]?.content).toContain("Memory Scope Capabilities");
  });
});

describe("SaaS memory scope and index helpers", () => {
  it("uses unambiguous tuple keys for compound scopes", () => {
    expect(toMemoryScopePartition({ scope: "agent", team_name: "a:b", agent_name: "c" })).toEqual({
      scope: "agent",
      scope_id: JSON.stringify(["a:b", "c"]),
    });
    expect(toMemoryScopePartition({ scope: "workspace", user_id: "user", workspace_key: "workspace" })).toEqual({
      scope: "workspace",
      scope_id: JSON.stringify(["user", "workspace"]),
    });
    expect(toMemoryScopePartition({ scope: "workspace", workspace_key: "workspace" })).toBeNull();
  });

  it("renders one-line, bounded database indices without entry bodies", () => {
    const rendered = renderPersistedMemoryIndex([
      entry({ name: "Line\nbreak", description: "First\nsummary", id: "memory-1" }),
      entry({ name: "Second", description: "Second summary", id: "memory-2" }),
    ], { maxLines: 1, maxChars: 200 });

    expect(rendered).toBe("- Line break (memory_id: memory-1, type: preference): First summary");
    expect(rendered).not.toContain("explicit read");
    expect(rendered.split("\n")).toHaveLength(1);
  });
});
