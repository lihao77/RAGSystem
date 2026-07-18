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
  RejectPersistedMemoryCandidateInput,
  ReleasePersistedMemoryCandidateInput,
  UpdatePersistedMemoryCandidateInput,
  WithdrawPersistedMemoryCandidateInput,
} from "./persistence-types.js";

/**
 * Durable, tenant-scoped persistence boundary for a SQL-backed memory adapter.
 *
 * Every lookup must include tenant_id. Implementations must treat approveCandidate as one
 * database transaction. On success that transaction changes the candidate and memory row and
 * increments the affected scope revision exactly once; partial publication is forbidden.
 */
export interface TransactionalMemoryRepository {
  getEntry(tenantId: string, memoryId: string): Promise<PersistedMemoryEntry | null>;
  listEntries(
    partition: MemoryPartition,
    options?: PersistedMemoryListOptions,
  ): Promise<PersistedMemoryEntry[]>;
  getScopeRevision(partition: MemoryPartition): Promise<number>;

  createCandidate(input: CreatePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidate>;
  getCandidate(tenantId: string, candidateId: string): Promise<PersistedMemoryCandidate | null>;
  listCandidates(options: PersistedMemoryCandidateListOptions): Promise<PersistedMemoryCandidate[]>;
  countCandidates(options: PersistedMemoryCandidateCountOptions): Promise<number>;
  updateCandidate(input: UpdatePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult>;
  withdrawCandidate(input: WithdrawPersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult>;
  claimCandidate(input: ClaimPersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateClaimResult>;
  releaseCandidate(input: ReleasePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult>;
  rejectCandidate(input: RejectPersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult>;

  /**
   * Atomically approves either candidate operation:
   * - publish: create the active entry, approve the candidate, bump the scope revision;
   * - archive: archive the active target, approve the candidate, bump the scope revision.
   *
   * expected_version is an optimistic lock. Missing/cross-tenant rows return not_found;
   * stale or non-candidate rows return state_conflict; a missing archive target returns
   * target_not_found. Non-applied outcomes must leave all rows and revisions unchanged.
   */
  approveCandidate(
    input: ApprovePersistedMemoryCandidateInput,
  ): Promise<PersistedMemoryCandidateApprovalResult>;
}
