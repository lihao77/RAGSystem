import { describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { PersistedMemoryEntry } from "../../src/contracts/memory-store/index.js";
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

  it("creates publish and archive candidates without mutating entries directly", async () => {
    const entry = memoryEntry({ scope: "user", scope_id: "usr-1" });
    const createCandidate = vi.fn(async (input: Record<string, unknown>) => ({ id: input.operation === "archive" ? "cand-2" : "cand-1" }));
    const service = new SaaSMemoryToolService(application({
      getEntry: vi.fn(async () => entry),
      createCandidate,
    }), sessions());
    const context = runtimeContext({ allowed: ["user"], write: ["user"], archive: ["user"] });

    await expect(service.writeMemory({
      scope: "user",
      name: "Preference",
      description: "Answer preference",
      memoryType: "preference",
      content: "Be concise",
    }, context)).resolves.toMatchObject({
      success: true,
      content: { saved: true, candidate_id: "cand-1", scope: "user" },
    });
    expect(createCandidate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      operation: "publish",
      owner_user_id: "usr-1",
      scope: "user",
      scope_id: "usr-1",
    }));

    await expect(service.archiveMemory({ scope: "user", fileName: "mem-1" }, context)).resolves.toMatchObject({
      success: true,
      content: { saved: true, candidate_id: "cand-2", memory_id: "mem-1" },
    });
    expect(createCandidate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      operation: "archive",
      owner_user_id: "usr-1",
      target_memory_id: "mem-1",
    }));
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
}): MemoryApplication {
  return {
    query: {
      listEntries: overrides.listEntries ?? (async () => []),
      getEntry: overrides.getEntry ?? (async () => null),
      getScopeRevision: async () => 0,
    },
    commands: {
      createCandidate: overrides.createCandidate ?? (async () => { throw new Error("unexpected candidate"); }),
      updateCandidate: async () => ({ outcome: "not_found" }),
      withdrawCandidate: async () => ({ outcome: "not_found" }),
    },
    governance: {} as MemoryApplication["governance"],
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
  return { getSession: () => ({ metadata: { team: "alpha" } }) };
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
