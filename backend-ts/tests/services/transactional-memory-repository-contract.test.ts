import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type {
  ApprovePersistedMemoryCandidateInput,
  ClaimPersistedMemoryCandidateInput,
  CreatePersistedMemoryCandidateInput,
  MemoryPartition,
  PersistedMemoryCandidate,
  PersistedMemoryCandidateApprovalResult,
  PersistedMemoryCandidateClaimResult,
  PersistedMemoryCandidateCountOptions,
  PersistedMemoryCandidateListOptions,
  PersistedMemoryCandidateMutationResult,
  PersistedMemoryEntry,
  PersistedMemoryListOptions,
  PersistedMemoryManagementCountOptions,
  PersistedMemoryManagementListOptions,
  RejectPersistedMemoryCandidateInput,
  ReleasePersistedMemoryCandidateInput,
  TransactionalMemoryRepository,
  UpdatePersistedMemoryCandidateInput,
  WithdrawPersistedMemoryCandidateInput,
} from "../../src/contracts/memory-store/index.js";
import { MemoryPartitionSchema, PersistedMemoryStatusSchema } from "../../src/contracts/memory-store/index.js";

const partitionKey = (partition: MemoryPartition): string =>
  `${partition.tenant_id}:${partition.scope}:${partition.scope_id}`;
const samePartition = (a: MemoryPartition, b: MemoryPartition): boolean =>
  a.tenant_id === b.tenant_id && a.scope === b.scope && a.scope_id === b.scope_id;

class InMemoryTransactionalMemoryRepository implements TransactionalMemoryRepository {
  private readonly entries = new Map<string, PersistedMemoryEntry>();
  private readonly candidates = new Map<string, PersistedMemoryCandidate>();
  private readonly revisions = new Map<string, number>();

  async getEntry(tenantId: string, memoryId: string): Promise<PersistedMemoryEntry | null> {
    const entry = this.entries.get(memoryId);
    return entry?.tenant_id === tenantId ? entry : null;
  }

  async listEntries(partition: MemoryPartition, options: PersistedMemoryListOptions = {}): Promise<PersistedMemoryEntry[]> {
    const rows = [...this.entries.values()].filter((entry) =>
      samePartition(entry, partition) && (options.include_archived || entry.status === "active"));
    return rows.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? rows.length));
  }

  async getScopeRevision(partition: MemoryPartition): Promise<number> {
    return this.revisions.get(partitionKey(partition)) ?? 0;
  }

  async listManagedEntries(options: PersistedMemoryManagementListOptions): Promise<PersistedMemoryEntry[]> {
    const rows = [...this.entries.values()].filter((entry) => entry.tenant_id === options.tenant_id);
    return rows.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? rows.length));
  }

  async countManagedEntries(options: PersistedMemoryManagementCountOptions): Promise<number> {
    return (await this.listManagedEntries(options)).length;
  }

  async createCandidate(input: CreatePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidate> {
    const now = new Date().toISOString();
    const candidate: PersistedMemoryCandidate = {
      ...input,
      id: randomUUID(),
      target_memory_id: input.operation === "archive" ? input.target_memory_id : null,
      name: input.operation === "publish" ? input.name : null,
      description: input.operation === "publish" ? input.description : null,
      memory_type: input.operation === "publish" ? input.memory_type : null,
      content: input.operation === "publish" ? input.content : null,
      why: input.operation === "publish" ? input.why ?? null : null,
      how_to_apply: input.operation === "publish" ? input.how_to_apply ?? null : null,
      source_session_id: input.source_session_id ?? null,
      source_run_id: input.source_run_id ?? null,
      source_message_id: input.source_message_id ?? null,
      status: "candidate",
      reviewer_user_id: null,
      review_comment: null,
      published_memory_id: null,
      version: 1,
      created_at: now,
      updated_at: now,
      reviewed_at: null,
    };
    this.candidates.set(candidate.id, candidate);
    return candidate;
  }

  async getCandidate(tenantId: string, candidateId: string): Promise<PersistedMemoryCandidate | null> {
    const candidate = this.candidates.get(candidateId);
    return candidate?.tenant_id === tenantId ? candidate : null;
  }

  async listCandidates(options: PersistedMemoryCandidateListOptions): Promise<PersistedMemoryCandidate[]> {
    const rows = [...this.candidates.values()].filter((candidate) =>
      candidate.tenant_id === options.tenant_id
      && (options.owner_user_id == null || candidate.owner_user_id === options.owner_user_id)
      && (!options.statuses?.length || options.statuses.includes(candidate.status))
      && (options.scope == null || candidate.scope === options.scope)
      && (options.scope_id == null || candidate.scope_id === options.scope_id)
      && (options.operation == null || candidate.operation === options.operation));
    return rows.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? rows.length));
  }

  async countCandidates(options: PersistedMemoryCandidateCountOptions): Promise<number> {
    return (await this.listCandidates(options)).length;
  }

  private mutateCandidate(
    tenantId: string,
    candidateId: string,
    update: (current: PersistedMemoryCandidate) => PersistedMemoryCandidate | null,
  ): PersistedMemoryCandidateMutationResult {
    const current = this.candidates.get(candidateId);
    if (!current || current.tenant_id !== tenantId) return { outcome: "not_found" };
    const next = update(current);
    if (!next) return { outcome: "state_conflict" };
    this.candidates.set(candidateId, next);
    return { outcome: "applied", candidate: next };
  }

  async updateCandidate(input: UpdatePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult> {
    return this.mutateCandidate(input.tenant_id, input.candidate_id, (current) =>
      current.owner_user_id === input.owner_user_id && current.status === "candidate"
        && current.version === input.expected_version && !current.review_claim_token
        ? { ...current, name: input.name ?? current.name, description: input.description ?? current.description,
            content: input.content ?? current.content, why: input.why === undefined ? current.why : input.why,
            how_to_apply: input.how_to_apply === undefined ? current.how_to_apply : input.how_to_apply,
            version: current.version + 1, updated_at: new Date().toISOString() }
        : null);
  }

  async withdrawCandidate(input: WithdrawPersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult> {
    return this.mutateCandidate(input.tenant_id, input.candidate_id, (current) =>
      current.owner_user_id === input.owner_user_id && current.status === "candidate"
        && current.version === input.expected_version && !current.review_claim_token
        ? { ...current, status: "withdrawn", version: current.version + 1, updated_at: new Date().toISOString() }
        : null);
  }

  async claimCandidate(input: ClaimPersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateClaimResult> {
    const token = randomUUID();
    const current = await this.getCandidate(input.tenant_id, input.candidate_id);
    if (!current) return { outcome: "not_found" };
    if (current.status !== "candidate" || current.version !== input.expected_version || current.review_claim_token) {
      return { outcome: "state_conflict" };
    }
    const claimed = { ...current, reviewer_user_id: input.reviewer_user_id, review_claim_token: token,
      review_claimed_at: new Date().toISOString(), version: current.version + 1, updated_at: new Date().toISOString() };
    this.candidates.set(current.id, claimed);
    return { outcome: "claimed", candidate: claimed, review_claim_token: token };
  }

  async releaseCandidate(input: ReleasePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult> {
    return this.mutateCandidate(input.tenant_id, input.candidate_id, (current) =>
      current.status === "candidate" && current.reviewer_user_id === input.reviewer_user_id
        && current.review_claim_token === input.review_claim_token
        ? { ...current, reviewer_user_id: null, review_claim_token: null, review_claimed_at: null,
            version: current.version + 1, updated_at: new Date().toISOString() }
        : null);
  }

  async rejectCandidate(input: RejectPersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult> {
    return this.mutateCandidate(input.tenant_id, input.candidate_id, (current) =>
      current.status === "candidate" && current.reviewer_user_id === input.reviewer_user_id
        && current.review_claim_token === input.review_claim_token
        ? { ...current, status: "rejected", review_comment: input.review_comment ?? null,
            review_claim_token: null, review_claimed_at: null, reviewed_at: new Date().toISOString(),
            version: current.version + 1, updated_at: new Date().toISOString() }
        : null);
  }

  async approveCandidate(input: ApprovePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateApprovalResult> {
    const candidate = await this.getCandidate(input.tenant_id, input.candidate_id);
    if (!candidate) return { outcome: "not_found" };
    if (candidate.status !== "candidate" || candidate.version !== input.expected_version) {
      return { outcome: "state_conflict" };
    }

    const existing = candidate.target_memory_id ? await this.getEntry(input.tenant_id, candidate.target_memory_id) : null;
    if (candidate.operation === "archive" && (!existing || existing.status !== "active" || !samePartition(existing, candidate))) {
      return { outcome: "target_not_found" };
    }

    const now = new Date().toISOString();
    const memory: PersistedMemoryEntry = candidate.operation === "publish"
      ? {
          tenant_id: candidate.tenant_id, scope: candidate.scope, scope_id: candidate.scope_id,
          id: randomUUID(), name: candidate.name!, description: candidate.description!,
          memory_type: candidate.memory_type!, content: candidate.content!, why: candidate.why,
          how_to_apply: candidate.how_to_apply, status: "active", source_run_id: candidate.source_run_id,
          source_message_id: candidate.source_message_id, version: 1, created_at: now, updated_at: now, archived_at: null,
        }
      : { ...existing!, status: "archived", version: existing!.version + 1, updated_at: now, archived_at: now };

    const approved: PersistedMemoryCandidate = {
      ...candidate, status: "approved", reviewer_user_id: input.reviewer_user_id,
      review_comment: input.review_comment ?? null, published_memory_id: memory.id,
      version: candidate.version + 1, updated_at: now, reviewed_at: now,
    };
    const revision = (await this.getScopeRevision(candidate)) + 1;
    this.entries.set(memory.id, memory);
    this.candidates.set(approved.id, approved);
    this.revisions.set(partitionKey(candidate), revision);
    return { outcome: candidate.operation === "publish" ? "published" : "archived", candidate: approved, memory, scope_revision: revision };
  }
}

const partition = (tenant_id: string, scope_id = "team-1"): MemoryPartition => ({ tenant_id, scope: "team", scope_id });
const publishInput = (tenant_id: string): CreatePersistedMemoryCandidateInput => ({
  ...partition(tenant_id), operation: "publish", owner_user_id: "owner-1", name: "policy",
  description: "shared policy", memory_type: "fact", content: "Use citations.",
});

describe("TransactionalMemoryRepository contract", () => {
  it("defines validated tenant and stable scope identity", () => {
    expect(MemoryPartitionSchema.parse(partition("tenant-a"))).toEqual(partition("tenant-a"));
    expect(() => MemoryPartitionSchema.parse({ tenant_id: "", scope: "team", scope_id: "team-1" })).toThrow();
    expect(PersistedMemoryStatusSchema.options).toEqual(["active", "archived"]);
  });

  it("publishes candidate, approves it, and increments revision atomically", async () => {
    const store: TransactionalMemoryRepository = new InMemoryTransactionalMemoryRepository();
    const candidate = await store.createCandidate(publishInput("tenant-a"));
    const result = await store.approveCandidate({ tenant_id: "tenant-a", candidate_id: candidate.id, reviewer_user_id: "admin", expected_version: 1 });

    expect(result.outcome).toBe("published");
    if (result.outcome !== "published") throw new Error("publish failed");
    expect(result.memory.status).toBe("active");
    expect(result.candidate.status).toBe("approved");
    expect(result.scope_revision).toBe(1);
    expect(await store.listEntries(partition("tenant-a"))).toEqual([result.memory]);
  });

  it("isolates identical ids and scope identities by tenant", async () => {
    const store = new InMemoryTransactionalMemoryRepository();
    const candidate = await store.createCandidate(publishInput("tenant-a"));
    expect(await store.getCandidate("tenant-b", candidate.id)).toBeNull();
    expect((await store.approveCandidate({ tenant_id: "tenant-b", candidate_id: candidate.id, reviewer_user_id: "admin", expected_version: 1 })).outcome).toBe("not_found");
    expect(await store.getScopeRevision(partition("tenant-a"))).toBe(0);
  });

  it("leaves memory and revision unchanged on optimistic-lock conflict", async () => {
    const store = new InMemoryTransactionalMemoryRepository();
    const candidate = await store.createCandidate(publishInput("tenant-a"));
    const result = await store.approveCandidate({ tenant_id: "tenant-a", candidate_id: candidate.id, reviewer_user_id: "admin", expected_version: 99 });
    expect(result.outcome).toBe("state_conflict");
    expect(await store.listEntries(partition("tenant-a"))).toHaveLength(0);
    expect(await store.getScopeRevision(partition("tenant-a"))).toBe(0);
  });

  it("archives through candidate approval and hides archived entries by default", async () => {
    const store = new InMemoryTransactionalMemoryRepository();
    const publish = await store.createCandidate(publishInput("tenant-a"));
    const published = await store.approveCandidate({ tenant_id: "tenant-a", candidate_id: publish.id, reviewer_user_id: "admin", expected_version: 1 });
    if (published.outcome !== "published") throw new Error("publish failed");
    const archive = await store.createCandidate({ ...partition("tenant-a"), operation: "archive", owner_user_id: "owner-1", target_memory_id: published.memory.id });
    const archived = await store.approveCandidate({ tenant_id: "tenant-a", candidate_id: archive.id, reviewer_user_id: "admin", expected_version: 1 });

    expect(archived.outcome).toBe("archived");
    expect(await store.listEntries(partition("tenant-a"))).toHaveLength(0);
    expect((await store.listEntries(partition("tenant-a"), { include_archived: true }))[0]?.status).toBe("archived");
    expect(await store.getScopeRevision(partition("tenant-a"))).toBe(2);
  });

  it("lists and counts candidates within the requested tenant", async () => {
    const store = new InMemoryTransactionalMemoryRepository();
    await store.createCandidate(publishInput("tenant-a"));
    await store.createCandidate(publishInput("tenant-b"));

    expect(await store.countCandidates({ tenant_id: "tenant-a", statuses: ["candidate"] })).toBe(1);
    expect(await store.listCandidates({ tenant_id: "tenant-b", owner_user_id: "owner-1" }))
      .toHaveLength(1);
  });

  it("protects owner edits and withdrawal with an optimistic version", async () => {
    const store = new InMemoryTransactionalMemoryRepository();
    const created = await store.createCandidate(publishInput("tenant-a"));
    const stale = await store.updateCandidate({ tenant_id: "tenant-a", candidate_id: created.id,
      owner_user_id: "owner-1", expected_version: 2, content: "changed" });
    expect(stale.outcome).toBe("state_conflict");

    const updated = await store.updateCandidate({ tenant_id: "tenant-a", candidate_id: created.id,
      owner_user_id: "owner-1", expected_version: 1, content: "changed" });
    expect(updated.outcome).toBe("applied");
    const withdrawn = await store.withdrawCandidate({ tenant_id: "tenant-a", candidate_id: created.id,
      owner_user_id: "owner-1", expected_version: 2 });
    expect(withdrawn.outcome).toBe("applied");
    expect((await store.getCandidate("tenant-a", created.id))?.status).toBe("withdrawn");
  });

  it("requires the active claim token to release or reject a candidate", async () => {
    const store = new InMemoryTransactionalMemoryRepository();
    const created = await store.createCandidate(publishInput("tenant-a"));
    const claimed = await store.claimCandidate({ tenant_id: "tenant-a", candidate_id: created.id,
      reviewer_user_id: "reviewer-1", expected_version: 1 });
    expect(claimed.outcome).toBe("claimed");
    if (claimed.outcome !== "claimed") throw new Error("claim failed");

    expect((await store.releaseCandidate({ tenant_id: "tenant-a", candidate_id: created.id,
      reviewer_user_id: "reviewer-2", review_claim_token: claimed.review_claim_token })).outcome)
      .toBe("state_conflict");
    expect((await store.rejectCandidate({ tenant_id: "tenant-b", candidate_id: created.id,
      reviewer_user_id: "reviewer-1", review_claim_token: claimed.review_claim_token })).outcome)
      .toBe("not_found");
    const rejected = await store.rejectCandidate({ tenant_id: "tenant-a", candidate_id: created.id,
      reviewer_user_id: "reviewer-1", review_claim_token: claimed.review_claim_token,
      review_comment: "not suitable" });
    expect(rejected.outcome).toBe("applied");
    expect(rejected.outcome === "applied" && rejected.candidate.status).toBe("rejected");
  });
});
