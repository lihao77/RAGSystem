import type {
  PersistedMemoryCandidate,
  PersistedMemoryCandidateMutationResult,
  TransactionalMemoryRepository,
} from "../../contracts/memory-store/index.js";
import { bindMemoryPartition, requireMemoryIdentifier, requireTenantId } from "./tenant-boundary.js";
import type {
  CreateMemoryCandidateCommand,
  UpdateMemoryCandidateCommand,
  WithdrawMemoryCandidateCommand,
} from "./types.js";

export interface MemoryCommandService {
  createCandidate(input: CreateMemoryCandidateCommand): Promise<PersistedMemoryCandidate>;
  updateCandidate(input: UpdateMemoryCandidateCommand): Promise<PersistedMemoryCandidateMutationResult>;
  withdrawCandidate(input: WithdrawMemoryCandidateCommand): Promise<PersistedMemoryCandidateMutationResult>;
}

export class TenantMemoryCommandService implements MemoryCommandService {
  private readonly tenantId: string;

  constructor(
    tenantId: string,
    private readonly repository: TransactionalMemoryRepository,
  ) {
    this.tenantId = requireTenantId(tenantId);
  }

  createCandidate(input: CreateMemoryCandidateCommand): Promise<PersistedMemoryCandidate> {
    const partition = bindMemoryPartition(this.tenantId, input);
    return this.repository.createCandidate({ ...input, ...partition });
  }

  updateCandidate(input: UpdateMemoryCandidateCommand): Promise<PersistedMemoryCandidateMutationResult> {
    requireMemoryIdentifier(input.candidate_id, "candidate_id");
    requireMemoryIdentifier(input.owner_user_id, "owner_user_id");
    return this.repository.updateCandidate({ ...input, tenant_id: this.tenantId });
  }

  withdrawCandidate(input: WithdrawMemoryCandidateCommand): Promise<PersistedMemoryCandidateMutationResult> {
    requireMemoryIdentifier(input.candidate_id, "candidate_id");
    requireMemoryIdentifier(input.owner_user_id, "owner_user_id");
    return this.repository.withdrawCandidate({ ...input, tenant_id: this.tenantId });
  }
}
