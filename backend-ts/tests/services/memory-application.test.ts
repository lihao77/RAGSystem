import { describe, expect, it, vi } from "vitest";

import type {
  PersistedMemoryCandidate,
  PersistedMemoryCandidateApprovalResult,
  PersistedMemoryCandidateClaimResult,
  PersistedMemoryCandidateMutationResult,
  PersistedMemoryEntry,
  TransactionalMemoryRepository,
} from "../../src/contracts/memory-store/index.js";
import { createMemoryApplication } from "../../src/services/memory/index.js";

const now = "2026-07-18T00:00:00.000Z";

const entry: PersistedMemoryEntry = {
  tenant_id: "tenant-a",
  scope: "team",
  scope_id: "team-1",
  id: "memory-1",
  name: "Policy",
  description: "Shared policy",
  memory_type: "fact",
  content: "Use citations.",
  why: null,
  how_to_apply: null,
  status: "active",
  source_run_id: null,
  source_message_id: null,
  version: 1,
  created_at: now,
  updated_at: now,
  archived_at: null,
};

const candidate: PersistedMemoryCandidate = {
  tenant_id: "tenant-a",
  scope: "team",
  scope_id: "team-1",
  id: "candidate-1",
  owner_user_id: "owner-1",
  operation: "publish",
  target_memory_id: null,
  name: "Policy",
  description: "Shared policy",
  memory_type: "fact",
  content: "Use citations.",
  why: null,
  how_to_apply: null,
  status: "candidate",
  source_session_id: null,
  source_run_id: null,
  source_message_id: null,
  reviewer_user_id: null,
  review_comment: null,
  published_memory_id: null,
  version: 1,
  created_at: now,
  updated_at: now,
  reviewed_at: null,
};

function repository(): TransactionalMemoryRepository {
  const approval: PersistedMemoryCandidateApprovalResult = {
    outcome: "published", candidate, memory: entry, scope_revision: 8,
  };
  const mutation: PersistedMemoryCandidateMutationResult = { outcome: "applied", candidate };
  const claim: PersistedMemoryCandidateClaimResult = {
    outcome: "claimed", candidate, review_claim_token: "claim-1",
  };
  return {
    getEntry: vi.fn(async () => entry),
    listEntries: vi.fn(async () => [entry]),
    listManagedEntries: vi.fn(async () => [entry]),
    countManagedEntries: vi.fn(async () => 1),
    getScopeRevision: vi.fn(async () => 7),
    createCandidate: vi.fn(async () => candidate),
    getCandidate: vi.fn(async () => candidate),
    listCandidates: vi.fn(async () => [candidate]),
    countCandidates: vi.fn(async () => 1),
    updateCandidate: vi.fn(async () => mutation),
    withdrawCandidate: vi.fn(async () => mutation),
    claimCandidate: vi.fn(async () => claim),
    releaseCandidate: vi.fn(async () => mutation),
    rejectCandidate: vi.fn(async () => mutation),
    approveCandidate: vi.fn(async () => approval),
  };
}

describe("MemoryApplication", () => {
  it("binds query operations to the application tenant", async () => {
    const store = repository();
    const memory = createMemoryApplication("tenant-a", store);

    await expect(memory.query.getEntry("memory-1")).resolves.toBe(entry);
    await expect(memory.query.listEntries(
      { scope: "team", scope_id: "team-1" },
      { include_archived: true, limit: 10 },
    )).resolves.toEqual([entry]);
    await expect(memory.query.getScopeRevision({ scope: "team", scope_id: "team-1" })).resolves.toBe(7);

    expect(store.getEntry).toHaveBeenCalledWith("tenant-a", "memory-1");
    expect(store.listEntries).toHaveBeenCalledWith(
      { tenant_id: "tenant-a", scope: "team", scope_id: "team-1" },
      { include_archived: true, limit: 10 },
    );
    expect(store.getScopeRevision).toHaveBeenCalledWith({
      tenant_id: "tenant-a", scope: "team", scope_id: "team-1",
    });
  });

  it("creates candidates through the command boundary", async () => {
    const store = repository();
    const memory = createMemoryApplication("tenant-a", store);

    await expect(memory.commands.createCandidate({
      scope: "team",
      scope_id: "team-1",
      operation: "publish",
      owner_user_id: "owner-1",
      name: "Policy",
      description: "Shared policy",
      memory_type: "fact",
      content: "Use citations.",
    })).resolves.toBe(candidate);

    expect(store.createCandidate).toHaveBeenCalledWith({
      tenant_id: "tenant-a",
      scope: "team",
      scope_id: "team-1",
      operation: "publish",
      owner_user_id: "owner-1",
      name: "Policy",
      description: "Shared policy",
      memory_type: "fact",
      content: "Use citations.",
    });
  });

  it("keeps candidate lookup and transactional approval behind governance", async () => {
    const store = repository();
    const memory = createMemoryApplication("tenant-a", store);

    await expect(memory.governance.getCandidate("candidate-1")).resolves.toBe(candidate);
    await expect(memory.governance.approveCandidate({
      candidate_id: "candidate-1",
      reviewer_user_id: "admin-1",
      expected_version: 1,
      review_comment: "Approved",
    })).resolves.toMatchObject({ outcome: "published", scope_revision: 8 });

    expect(store.getCandidate).toHaveBeenCalledWith("tenant-a", "candidate-1");
    expect(store.approveCandidate).toHaveBeenCalledWith({
      tenant_id: "tenant-a",
      candidate_id: "candidate-1",
      reviewer_user_id: "admin-1",
      expected_version: 1,
      review_comment: "Approved",
    });
  });

  it("separates owner mutations from reviewer governance", async () => {
    const store = repository();
    const memory = createMemoryApplication("tenant-a", store);

    await memory.commands.updateCandidate({
      candidate_id: "candidate-1", owner_user_id: "owner-1", expected_version: 1, content: "Updated",
    });
    await memory.commands.withdrawCandidate({
      candidate_id: "candidate-1", owner_user_id: "owner-1", expected_version: 2,
    });
    await memory.governance.listCandidates({ statuses: ["candidate"], limit: 20 });
    await memory.governance.countCandidates({ statuses: ["candidate"] });
    await memory.governance.claimCandidate({
      candidate_id: "candidate-1", reviewer_user_id: "admin-1", expected_version: 1,
    });
    await memory.governance.releaseCandidate({
      candidate_id: "candidate-1", reviewer_user_id: "admin-1", review_claim_token: "claim-1",
    });
    await memory.governance.rejectCandidate({
      candidate_id: "candidate-1", reviewer_user_id: "admin-1", review_claim_token: "claim-1",
      review_comment: "Duplicate",
    });

    expect(store.updateCandidate).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a" }));
    expect(store.withdrawCandidate).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a" }));
    expect(store.listCandidates).toHaveBeenCalledWith({ tenant_id: "tenant-a", statuses: ["candidate"], limit: 20 });
    expect(store.countCandidates).toHaveBeenCalledWith({ tenant_id: "tenant-a", statuses: ["candidate"] });
    expect(store.claimCandidate).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a" }));
    expect(store.releaseCandidate).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a" }));
    expect(store.rejectCandidate).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-a" }));
  });

  it("rejects invalid tenant, scope, and identifiers before repository access", async () => {
    const store = repository();
    expect(() => createMemoryApplication(" ", store)).toThrow("tenantId must not be empty");

    const memory = createMemoryApplication("tenant-a", store);
    expect(() => memory.query.getEntry(" ")).toThrow("memoryId must not be empty");
    expect(() => memory.query.listEntries({ scope: "team", scope_id: "" })).toThrow();
    expect(() => memory.governance.approveCandidate({
      candidate_id: "candidate-1",
      reviewer_user_id: " ",
      expected_version: 1,
    })).toThrow("reviewer_user_id must not be empty");
    expect(store.getEntry).not.toHaveBeenCalled();
    expect(store.listEntries).not.toHaveBeenCalled();
    expect(store.approveCandidate).not.toHaveBeenCalled();
  });
});
