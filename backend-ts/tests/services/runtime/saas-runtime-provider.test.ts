import { describe, expect, it, vi } from "vitest";

import type {
  PersistedMemoryCandidateApprovalResult,
  PersistedMemoryCandidateClaimResult,
  PersistedMemoryCandidateMutationResult,
  TransactionalMemoryRepository,
} from "../../../src/contracts/memory-store/index.js";
import { SaaSRuntimeProvider } from "../../../src/services/runtime/saas-runtime-provider.js";
import { SaaSMemoryContextSource } from "../../../src/services/agent/memory/saas-memory-context-source.js";
import { SaaSMemoryToolService } from "../../../src/tools/MemoryTools/SaaSMemoryExecution.js";

function repository(): TransactionalMemoryRepository {
  const mutation: PersistedMemoryCandidateMutationResult = { outcome: "not_found" };
  const claim: PersistedMemoryCandidateClaimResult = { outcome: "not_found" };
  const approval: PersistedMemoryCandidateApprovalResult = { outcome: "not_found" };
  return {
    getEntry: vi.fn(async () => null),
    listEntries: vi.fn(async () => []),
    getScopeRevision: vi.fn(async () => 0),
    createCandidate: vi.fn(async () => { throw new Error("not implemented"); }),
    getCandidate: vi.fn(async () => null),
    listCandidates: vi.fn(async () => []),
    countCandidates: vi.fn(async () => 0),
    updateCandidate: vi.fn(async () => mutation),
    withdrawCandidate: vi.fn(async () => mutation),
    claimCandidate: vi.fn(async () => claim),
    releaseCandidate: vi.fn(async () => mutation),
    rejectCandidate: vi.fn(async () => mutation),
    approveCandidate: vi.fn(async () => approval),
  };
}

describe("SaaSRuntimeProvider", () => {
  it("creates lightweight tenant facades without retaining per-tenant infrastructure", () => {
    const store = repository();
    const provider = new SaaSRuntimeProvider(store);

    const first = provider.memoryForTenant(" tnt_alpha ");
    const second = provider.memoryForTenant("tnt_alpha");

    expect(first).not.toBe(second);
    expect(first).toEqual(expect.objectContaining({
      query: expect.anything(),
      commands: expect.anything(),
      governance: expect.anything(),
    }));
    expect(first).not.toHaveProperty("dataRoot");
    expect(first).not.toHaveProperty("dbPath");
  });

  it("binds each memory application to its requested tenant", async () => {
    const store = repository();
    const provider = new SaaSRuntimeProvider(store);
    const alpha = provider.memoryForTenant("tnt_alpha");
    const beta = provider.memoryForTenant("tnt_beta");

    await alpha.query.getEntry("memory-1");
    await beta.query.getEntry("memory-1");

    expect(store.getEntry).toHaveBeenNthCalledWith(1, "tnt_alpha", "memory-1");
    expect(store.getEntry).toHaveBeenNthCalledWith(2, "tnt_beta", "memory-1");
    expect(alpha).not.toBe(beta);
  });

  it("rejects invalid tenant identifiers before creating a facade", () => {
    const provider = new SaaSRuntimeProvider(repository());
    expect(() => provider.memoryForTenant("tenant-alpha")).toThrow("无效租户 ID");
  });

  it("creates tenant-bound bindings for the shared agent runtime", () => {
    const provider = new SaaSRuntimeProvider(repository());
    const sessions = {
      getSession: () => ({ metadata: {}, user_id: "usr_alpha" }),
      updateSessionMetadata: () => ({}),
    };

    const bindings = provider.createMemoryBindings("tnt_alpha", sessions);
    const source = bindings.createContextSource({
      sessions,
      memory: { auto_inject: true, allowed_scopes: ["session"], write_scopes: [], archive_scopes: [] },
      agentName: "assistant",
      memoryConfig: { index_max_lines: 25, index_max_chars: 4096 },
      dataRoot: "unused-in-saas",
    });

    expect(bindings.tools).toBeInstanceOf(SaaSMemoryToolService);
    expect(source).toBeInstanceOf(SaaSMemoryContextSource);
  });
});
