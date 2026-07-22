import { describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent/agent-config.js";
import type {
  PersistedMemoryCandidate,
  PersistedMemoryEntry,
} from "../../src/contracts/memory-store/index.js";
import type { MemoryApplication } from "../../src/services/memory/index.js";
import { SaaSMemoryToolService } from "../../src/tools/MemoryTools/SaaSMemoryExecution.js";

describe("SaaSMemoryToolService", () => {
  it("lists stable memory ids and reads only entries in the resolved partition", async () => {
    const entry = memoryEntry();
    const listEntries = vi.fn(async () => [entry]);
    const getEntry = vi.fn(async () => entry);
    const service = new SaaSMemoryToolService(application({ listEntries, getEntry }), sessions());
    const context = runtimeContext();

    await expect(service.listMemoryIndex({ scope: "agent" }, context)).resolves.toMatchObject({
      success: true,
      content: expect.stringContaining("[Answer style](mem-1)"),
      metadata: { scope: "agent" },
    });
    expect(listEntries).toHaveBeenCalledWith({
      scope: "agent",
      scope_id: JSON.stringify(["alpha", "orchestrator_agent"]),
    });
    await expect(service.readMemoryEntry({ scope: "agent", fileName: "mem-1" }, context)).resolves.toMatchObject({
      success: true,
      content: expect.stringContaining("Use concise answers"),
      metadata: { memory_id: "mem-1", scope: "agent" },
    });

    const wrongScope = new SaaSMemoryToolService(application({
      listEntries,
      getEntry: vi.fn(async () => ({ ...entry, scope_id: JSON.stringify(["other", "orchestrator_agent"]) })),
    }), sessions());
    await expect(wrongScope.readMemoryEntry({ scope: "agent", fileName: "mem-1" }, context)).resolves.toMatchObject({
      success: false,
      content: "memory 不存在: mem-1",
    });
  });

  it.each([
    ["session", "session-1"],
    ["user", "usr-1"],
    ["workspace", JSON.stringify(["usr-1", "workspace-a"])],
  ] as const)("publishes %s memory immediately and makes it readable", async (scope, scopeId) => {
    const entry = memoryEntry({ scope, scope_id: scopeId });
    const candidate = memoryCandidate({ scope, scope_id: scopeId });
    const createCandidate = vi.fn(async () => candidate);
    const approveCandidate = vi.fn(async () => ({
      outcome: "published" as const,
      candidate: { ...candidate, status: "approved" as const, published_memory_id: entry.id },
      memory: entry,
      scope_revision: 1,
    }));
    const listEntries = vi.fn(async () => [entry]);
    const service = new SaaSMemoryToolService(application({
      createCandidate,
      approveCandidate,
      listEntries,
    }), sessions());
    const context = runtimeContext({ allowed: [scope], write: [scope], archive: [scope] });

    await expect(service.writeMemory({
      scope,
      ...(scope === "workspace" ? { workspaceKey: "workspace-a" } : {}),
      name: "Preference",
      description: "Answer preference",
      memoryType: "preference",
      content: "Be concise",
    }, context)).resolves.toMatchObject({
      success: true,
    });
    expect(createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      operation: "publish",
      owner_user_id: "usr-1",
      scope,
      scope_id: scopeId,
    }));
    expect(approveCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidate_id: candidate.id,
      reviewer_user_id: "usr-1",
      expected_version: candidate.version,
    }));

    await expect(service.listMemoryIndex({
      scope,
      ...(scope === "workspace" ? { workspaceKey: "workspace-a" } : {}),
    }, context)).resolves.toMatchObject({
      success: true,
      content: expect.stringContaining("[Answer style](mem-1)"),
    });
    expect(listEntries).toHaveBeenCalledWith({ scope, scope_id: scopeId });
  });

  it("archives personal memory immediately", async () => {
    const entry = memoryEntry({ scope: "user", scope_id: "usr-1" });
    const candidate = memoryCandidate({ operation: "archive", target_memory_id: entry.id });
    const createCandidate = vi.fn(async () => candidate);
    const approveCandidate = vi.fn(async () => ({
      outcome: "archived" as const,
      candidate: { ...candidate, status: "approved" as const, published_memory_id: entry.id },
      memory: { ...entry, status: "archived" as const },
      scope_revision: 2,
    }));
    const service = new SaaSMemoryToolService(application({
      getEntry: vi.fn(async () => entry),
      createCandidate,
      approveCandidate,
    }), sessions());
    const context = runtimeContext({ allowed: ["user"], write: ["user"], archive: ["user"] });

    await expect(service.archiveMemory({ scope: "user", fileName: "mem-1" }, context)).resolves.toMatchObject({
      success: true,
    });
    expect(createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      operation: "archive",
      owner_user_id: "usr-1",
      target_memory_id: "mem-1",
    }));
    expect(approveCandidate).toHaveBeenCalledWith(expect.objectContaining({
      candidate_id: candidate.id,
      reviewer_user_id: "usr-1",
      expected_version: candidate.version,
    }));
  });

  it.each(["team", "agent"] as const)("keeps %s writes as review candidates", async (scope) => {
    const candidate = memoryCandidate({
      scope,
      scope_id: scope === "team" ? "alpha" : JSON.stringify(["alpha", "orchestrator_agent"]),
    });
    const createCandidate = vi.fn(async () => candidate);
    const approveCandidate = vi.fn();
    const service = new SaaSMemoryToolService(application({ createCandidate, approveCandidate }), sessions());
    const context = runtimeContext({ allowed: [scope], write: [scope], archive: [scope] });

    await expect(service.writeMemory({
      scope,
      name: "Policy",
      description: "Shared policy",
      memoryType: "fact",
      content: "Use citations",
    }, context)).resolves.toMatchObject({
      success: true,
      content: expect.objectContaining({ candidate_id: candidate.id }),
    });
    expect(createCandidate).toHaveBeenCalledOnce();
    expect(approveCandidate).not.toHaveBeenCalled();
  });

  it("lets the owner list and read a private shared-memory candidate", async () => {
    const candidate = memoryCandidate({
      scope: "team",
      scope_id: "alpha",
      name: "Draft policy",
      description: "Private until approved",
      content: "Use citations",
    });
    const listCandidates = vi.fn(async () => [candidate]);
    const getCandidate = vi.fn(async () => candidate);
    const service = new SaaSMemoryToolService(application({ listCandidates, getCandidate }), sessions());
    const context = runtimeContext({ allowed: ["team"], write: ["team"], archive: ["team"] });

    await expect(service.listMemoryIndex({ scope: "team" }, context)).resolves.toMatchObject({
      success: true,
      content: expect.stringContaining("[Draft policy](cand-1)"),
    });
    expect(listCandidates).toHaveBeenCalledWith(expect.objectContaining({
      owner_user_id: "usr-1",
      statuses: ["candidate"],
      scope: "team",
      scope_id: "alpha",
      operation: "publish",
    }));

    await expect(service.readMemoryEntry({ scope: "team", fileName: candidate.id }, context)).resolves.toMatchObject({
      success: true,
      content: expect.stringContaining("Use citations"),
      metadata: expect.objectContaining({ candidate_id: candidate.id, pending_review: true }),
    });
  });

  it("keeps configured scope permissions for SaaS candidate operations", () => {
    const service = new SaaSMemoryToolService(application({}), sessions());
    const context = runtimeContext({ allowed: ["session"], write: [], archive: [] });

    expect(service.checkMemoryScopeAccess({ scope: "session" }, context, "read")).toEqual({ action: "allow" });
    expect(service.checkMemoryScopeAccess({ scope: "session" }, context, "write")).toMatchObject({ action: "deny" });
    expect(service.checkMemoryScopeAccess({ scope: "session" }, context, "archive")).toMatchObject({ action: "deny" });
  });
});

function application(overrides: {
  listEntries?: (...args: any[]) => Promise<any>;
  getEntry?: (...args: any[]) => Promise<any>;
  createCandidate?: (...args: any[]) => Promise<any>;
  approveCandidate?: (...args: any[]) => Promise<any>;
  listCandidates?: (...args: any[]) => Promise<any>;
  getCandidate?: (...args: any[]) => Promise<any>;
}): MemoryApplication {
  return {
    query: {
      listEntries: overrides.listEntries ?? (async () => []),
      getEntry: overrides.getEntry ?? (async () => null),
      getScopeRevision: async () => 0,
      listManagedEntries: async () => [],
      countManagedEntries: async () => 0,
    },
    commands: {
      createCandidate: overrides.createCandidate ?? (async () => { throw new Error("unexpected candidate"); }),
      updateCandidate: async () => ({ outcome: "not_found" }),
      withdrawCandidate: async () => ({ outcome: "not_found" }),
    },
    governance: {
      getCandidate: overrides.getCandidate ?? (async () => null),
      listCandidates: overrides.listCandidates ?? (async () => []),
      countCandidates: async () => 0,
      claimCandidate: async () => ({ outcome: "not_found" }),
      releaseCandidate: async () => ({ outcome: "not_found" }),
      rejectCandidate: async () => ({ outcome: "not_found" }),
      approveCandidate: overrides.approveCandidate ?? (async () => { throw new Error("unexpected approval"); }),
    },
  };
}

function memoryCandidate(overrides: Partial<PersistedMemoryCandidate> = {}): PersistedMemoryCandidate {
  return {
    id: "cand-1",
    tenant_id: "tenant-1",
    scope: "user",
    scope_id: "usr-1",
    owner_user_id: "usr-1",
    operation: "publish",
    target_memory_id: null,
    name: "Answer style",
    description: "Preferred response style",
    memory_type: "preference",
    content: "Use concise answers",
    why: null,
    how_to_apply: null,
    status: "candidate",
    source_session_id: "session-1",
    source_run_id: "run-1",
    source_message_id: null,
    reviewer_user_id: null,
    review_comment: null,
    published_memory_id: null,
    version: 1,
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z",
    reviewed_at: null,
    ...overrides,
  };
}

function memoryEntry(overrides: Partial<PersistedMemoryEntry> = {}): PersistedMemoryEntry {
  return {
    id: "mem-1",
    tenant_id: "tenant-1",
    scope: "agent",
    scope_id: JSON.stringify(["alpha", "orchestrator_agent"]),
    name: "Answer style",
    description: "Preferred response style",
    memory_type: "preference",
    content: "Use concise answers",
    why: null,
    how_to_apply: null,
    status: "active",
    source_run_id: null,
    source_message_id: null,
    version: 1,
    created_at: "2026-07-18T00:00:00.000Z",
    updated_at: "2026-07-18T00:00:00.000Z",
    archived_at: null,
    ...overrides,
  };
}

function sessions() {
  return { getSession: async () => ({ metadata: { team: "alpha" } }) };
}

function runtimeContext(scopes: {
  allowed?: AgentConfig["memory"]["allowed_scopes"];
  write?: AgentConfig["memory"]["write_scopes"];
  archive?: AgentConfig["memory"]["archive_scopes"];
} = {}) {
  return {
    agent: {
      agent_name: "orchestrator_agent",
      memory: {
        auto_inject: true,
        allowed_scopes: scopes.allowed ?? ["agent"],
        write_scopes: scopes.write ?? ["agent"],
        archive_scopes: scopes.archive ?? ["agent"],
      },
    } as AgentConfig,
    sessionId: "session-1",
    userId: "usr-1",
    runId: "run-1",
  };
}
