import type {
  ApprovePersistedMemoryCandidateInput,
  ClaimPersistedMemoryCandidateInput,
  CreatePersistedMemoryCandidateInput,
  MemoryPartition,
  PersistedMemoryCandidateCountOptions,
  PersistedMemoryCandidateListOptions,
  RejectPersistedMemoryCandidateInput,
  ReleasePersistedMemoryCandidateInput,
  UpdatePersistedMemoryCandidateInput,
  WithdrawPersistedMemoryCandidateInput,
} from "../../contracts/memory-store/index.js";

export type MemoryScopePartition = Omit<MemoryPartition, "tenant_id">;

type WithoutTenant<T> = T extends unknown ? Omit<T, "tenant_id"> : never;

export type CreateMemoryCandidateCommand = WithoutTenant<CreatePersistedMemoryCandidateInput>;
export type UpdateMemoryCandidateCommand = WithoutTenant<UpdatePersistedMemoryCandidateInput>;
export type WithdrawMemoryCandidateCommand = WithoutTenant<WithdrawPersistedMemoryCandidateInput>;
export type ApproveMemoryCandidateCommand = Omit<
  ApprovePersistedMemoryCandidateInput,
  "tenant_id"
>;
export type ClaimMemoryCandidateCommand = WithoutTenant<ClaimPersistedMemoryCandidateInput>;
export type ReleaseMemoryCandidateCommand = WithoutTenant<ReleasePersistedMemoryCandidateInput>;
export type RejectMemoryCandidateCommand = WithoutTenant<RejectPersistedMemoryCandidateInput>;
export type MemoryCandidateListQuery = WithoutTenant<PersistedMemoryCandidateListOptions>;
export type MemoryCandidateCountQuery = WithoutTenant<PersistedMemoryCandidateCountOptions>;
