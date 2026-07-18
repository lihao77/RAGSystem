import type {
  PersistedMemoryCandidate,
  PersistedMemoryCandidateApprovalResult,
  PersistedMemoryCandidateClaimResult,
  PersistedMemoryCandidateMutationResult,
  TransactionalMemoryRepository,
} from "../../contracts/memory-store/index.js";
import { requireMemoryIdentifier, requireTenantId } from "./tenant-boundary.js";
import type {
  ApproveMemoryCandidateCommand,
  ClaimMemoryCandidateCommand,
  MemoryCandidateCountQuery,
  MemoryCandidateListQuery,
  RejectMemoryCandidateCommand,
  ReleaseMemoryCandidateCommand,
} from "./types.js";

export interface MemoryGovernanceService {
  getCandidate(candidateId: string): Promise<PersistedMemoryCandidate | null>;
  listCandidates(query?: MemoryCandidateListQuery): Promise<PersistedMemoryCandidate[]>;
  countCandidates(query?: MemoryCandidateCountQuery): Promise<number>;
  claimCandidate(input: ClaimMemoryCandidateCommand): Promise<PersistedMemoryCandidateClaimResult>;
  releaseCandidate(input: ReleaseMemoryCandidateCommand): Promise<PersistedMemoryCandidateMutationResult>;
  rejectCandidate(input: RejectMemoryCandidateCommand): Promise<PersistedMemoryCandidateMutationResult>;
  approveCandidate(
    input: ApproveMemoryCandidateCommand,
  ): Promise<PersistedMemoryCandidateApprovalResult>;
}

export class TenantMemoryGovernanceService implements MemoryGovernanceService {
  private readonly tenantId: string;

  constructor(
    tenantId: string,
    private readonly repository: TransactionalMemoryRepository,
  ) {
    this.tenantId = requireTenantId(tenantId);
  }

  getCandidate(candidateId: string): Promise<PersistedMemoryCandidate | null> {
    return this.repository.getCandidate(
      this.tenantId,
      requireMemoryIdentifier(candidateId, "candidateId"),
    );
  }

  listCandidates(query: MemoryCandidateListQuery = {}): Promise<PersistedMemoryCandidate[]> {
    return this.repository.listCandidates({ ...query, tenant_id: this.tenantId });
  }

  countCandidates(query: MemoryCandidateCountQuery = {}): Promise<number> {
    return this.repository.countCandidates({ ...query, tenant_id: this.tenantId });
  }

  claimCandidate(input: ClaimMemoryCandidateCommand): Promise<PersistedMemoryCandidateClaimResult> {
    requireMemoryIdentifier(input.candidate_id, "candidate_id");
    requireMemoryIdentifier(input.reviewer_user_id, "reviewer_user_id");
    return this.repository.claimCandidate({ ...input, tenant_id: this.tenantId });
  }

  releaseCandidate(input: ReleaseMemoryCandidateCommand): Promise<PersistedMemoryCandidateMutationResult> {
    requireMemoryIdentifier(input.candidate_id, "candidate_id");
    requireMemoryIdentifier(input.reviewer_user_id, "reviewer_user_id");
    requireMemoryIdentifier(input.review_claim_token, "review_claim_token");
    return this.repository.releaseCandidate({ ...input, tenant_id: this.tenantId });
  }

  rejectCandidate(input: RejectMemoryCandidateCommand): Promise<PersistedMemoryCandidateMutationResult> {
    requireMemoryIdentifier(input.candidate_id, "candidate_id");
    requireMemoryIdentifier(input.reviewer_user_id, "reviewer_user_id");
    requireMemoryIdentifier(input.review_claim_token, "review_claim_token");
    return this.repository.rejectCandidate({ ...input, tenant_id: this.tenantId });
  }

  approveCandidate(
    input: ApproveMemoryCandidateCommand,
  ): Promise<PersistedMemoryCandidateApprovalResult> {
    requireMemoryIdentifier(input.candidate_id, "candidate_id");
    requireMemoryIdentifier(input.reviewer_user_id, "reviewer_user_id");
    return this.repository.approveCandidate({ ...input, tenant_id: this.tenantId });
  }
}
