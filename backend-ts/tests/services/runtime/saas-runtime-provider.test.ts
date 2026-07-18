import { describe, expect, it, vi } from "vitest";

import type {
  PersistedMemoryCandidateApprovalResult,
  PersistedMemoryCandidateClaimResult,
  PersistedMemoryCandidateMutationResult,
  TransactionalMemoryRepository,
} from "../../../src/contracts/memory-store/index.js";
import { SaaSRuntimeProvider } from "../../../src/services/runtime/saas-runtime-provider.js";

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
  it("caches a lightweight tenant facade without creating per-tenant infrastructure", async () => {
    const store = repository();
    const provider = new SaaSRuntimeProvider(store);

    const first = await provider.acquire(" tnt_alpha ");
    const second = await provider.acquire("tnt_alpha");

    expect(first.tenantId).toBe("tnt_alpha");
    expect(first.runtime).toBe(second.runtime);
    expect(first.runtime).toEqual({
      tenantId: "tnt_alpha",
      memory: expect.objectContaining({ query: expect.anything(), commands: expect.anything(), governance: expect.anything() }),
    });
    expect(first.runtime).not.toHaveProperty("dataRoot");
    expect(first.runtime).not.toHaveProperty("dbPath");

    first.release();
    first.release();
    second.release();
  });

  it("binds each memory application to its acquired tenant", async () => {
    const store = repository();
    const provider = new SaaSRuntimeProvider(store);
    const alpha = await provider.acquire("tnt_alpha");
    const beta = await provider.acquire("tnt_beta");

    await alpha.runtime.memory.query.getEntry("memory-1");
    await beta.runtime.memory.query.getEntry("memory-1");

    expect(store.getEntry).toHaveBeenNthCalledWith(1, "tnt_alpha", "memory-1");
    expect(store.getEntry).toHaveBeenNthCalledWith(2, "tnt_beta", "memory-1");
    expect(alpha.runtime).not.toBe(beta.runtime);
  });

  it("evicts facades without closing the shared repository", async () => {
    const store = repository();
    const provider = new SaaSRuntimeProvider(store);
    const first = await provider.acquire("tnt_alpha");

    await provider.closeTenant("tnt_alpha");
    const second = await provider.acquire("tnt_alpha");
    expect(second.runtime).not.toBe(first.runtime);

    await provider.closeAll();
    const third = await provider.acquire("tnt_alpha");
    expect(third.runtime).not.toBe(second.runtime);
  });

  it("rejects invalid tenant identifiers before creating a facade", async () => {
    const provider = new SaaSRuntimeProvider(repository());
    await expect(provider.acquire("tenant-alpha")).rejects.toThrow("无效租户 ID");
  });
});
