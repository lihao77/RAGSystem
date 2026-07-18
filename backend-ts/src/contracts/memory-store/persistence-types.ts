import { z } from "zod";

import { MemoryScopeNameSchema } from "./types.js";

/** Stable database identity for one tenant-owned memory scope. */
export const MemoryPartitionSchema = z.object({
  tenant_id: z.string().min(1),
  scope: MemoryScopeNameSchema,
  scope_id: z.string().min(1),
});
export type MemoryPartition = z.infer<typeof MemoryPartitionSchema>;

export const PersistedMemoryStatusSchema = z.enum(["active", "archived"]);
export type PersistedMemoryStatus = z.infer<typeof PersistedMemoryStatusSchema>;

export interface PersistedMemoryEntry extends MemoryPartition {
  id: string;
  name: string;
  description: string;
  memory_type: string;
  content: string;
  why: string | null;
  how_to_apply: string | null;
  status: PersistedMemoryStatus;
  source_run_id: string | null;
  source_message_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface PublishMemoryCandidateInput extends MemoryPartition {
  operation: "publish";
  owner_user_id: string;
  name: string;
  description: string;
  memory_type: string;
  content: string;
  why?: string | null;
  how_to_apply?: string | null;
  source_session_id?: string | null;
  source_run_id?: string | null;
  source_message_id?: string | null;
}

export interface ArchiveMemoryCandidateInput extends MemoryPartition {
  operation: "archive";
  owner_user_id: string;
  target_memory_id: string;
  source_session_id?: string | null;
  source_run_id?: string | null;
  source_message_id?: string | null;
}

export type CreatePersistedMemoryCandidateInput =
  | PublishMemoryCandidateInput
  | ArchiveMemoryCandidateInput;

export type PersistedMemoryCandidateStatus = "candidate" | "approved" | "rejected" | "withdrawn";
export type PersistedMemoryCandidateOperation = "publish" | "archive";

export interface PersistedMemoryCandidate extends MemoryPartition {
  id: string;
  owner_user_id: string;
  operation: PersistedMemoryCandidateOperation;
  target_memory_id: string | null;
  name: string | null;
  description: string | null;
  memory_type: string | null;
  content: string | null;
  why: string | null;
  how_to_apply: string | null;
  status: PersistedMemoryCandidateStatus;
  source_session_id: string | null;
  source_run_id: string | null;
  source_message_id: string | null;
  reviewer_user_id: string | null;
  review_comment: string | null;
  published_memory_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  /** Absent only for records read before the review-claim migration was introduced. */
  review_claim_token?: string | null;
  review_claimed_at?: string | null;
}

export interface ApprovePersistedMemoryCandidateInput {
  tenant_id: string;
  candidate_id: string;
  reviewer_user_id: string;
  expected_version: number;
  review_comment?: string | null;
  /** When supplied, approval is restricted to the active reviewer claim. */
  review_claim_token?: string | null;
}

export interface AppliedMemoryCandidateApproval {
  outcome: "published" | "archived";
  candidate: PersistedMemoryCandidate;
  memory: PersistedMemoryEntry;
  scope_revision: number;
}

export interface RejectedMemoryCandidateApproval {
  outcome: "not_found" | "state_conflict" | "target_not_found";
}

export type PersistedMemoryCandidateApprovalResult =
  | AppliedMemoryCandidateApproval
  | RejectedMemoryCandidateApproval;

export interface PersistedMemoryListOptions {
  include_archived?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface PersistedMemoryManagementListOptions {
  tenant_id: string;
  scopes?: MemoryPartition["scope"][] | undefined;
  statuses?: PersistedMemoryStatus[] | undefined;
  search?: string | undefined;
  viewer_user_id?: string | undefined;
  viewer_session_ids?: string[] | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export type PersistedMemoryManagementCountOptions = Omit<
  PersistedMemoryManagementListOptions,
  "limit" | "offset"
>;

export interface PersistedMemoryManagementArchiveInput {
  tenant_id: string;
  memory_id: string;
  expected_version: number;
  viewer_user_id: string;
  viewer_session_ids: string[];
}

export type PersistedMemoryManagementLookupInput = Omit<
  PersistedMemoryManagementArchiveInput,
  "expected_version"
>;

export interface PersistedMemoryManagementResolvedEntry {
  memory: PersistedMemoryEntry;
  scope_spec: import("./types.js").MemoryScopeSpec;
  storage_key: string;
}

export type PersistedMemoryManagementArchiveResult =
  | { outcome: "archived"; memory: PersistedMemoryEntry }
  | { outcome: "not_found" }
  | { outcome: "state_conflict" };

export interface PersistedMemoryCandidateListOptions {
  tenant_id: string;
  owner_user_id?: string | undefined;
  statuses?: PersistedMemoryCandidateStatus[] | undefined;
  scope?: MemoryPartition["scope"] | undefined;
  scopes?: MemoryPartition["scope"][] | undefined;
  scope_id?: string | undefined;
  operation?: PersistedMemoryCandidateOperation | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export type PersistedMemoryCandidateCountOptions = Omit<
  PersistedMemoryCandidateListOptions,
  "limit" | "offset"
>;

export interface UpdatePersistedMemoryCandidateInput {
  tenant_id: string;
  candidate_id: string;
  owner_user_id: string;
  expected_version: number;
  name?: string | undefined;
  description?: string | undefined;
  content?: string | undefined;
  why?: string | null | undefined;
  how_to_apply?: string | null | undefined;
}

export interface WithdrawPersistedMemoryCandidateInput {
  tenant_id: string;
  candidate_id: string;
  owner_user_id: string;
  expected_version: number;
}

export interface ClaimPersistedMemoryCandidateInput {
  tenant_id: string;
  candidate_id: string;
  reviewer_user_id: string;
  expected_version: number;
  claim_ttl_seconds?: number | undefined;
}

export interface ReleasePersistedMemoryCandidateInput {
  tenant_id: string;
  candidate_id: string;
  reviewer_user_id: string;
  review_claim_token: string;
}

export interface RejectPersistedMemoryCandidateInput extends ReleasePersistedMemoryCandidateInput {
  review_comment?: string | null;
}

export type PersistedMemoryCandidateMutationResult =
  | { outcome: "applied"; candidate: PersistedMemoryCandidate }
  | { outcome: "not_found" | "state_conflict" };

export type PersistedMemoryCandidateClaimResult =
  | { outcome: "claimed"; candidate: PersistedMemoryCandidate; review_claim_token: string }
  | { outcome: "not_found" | "state_conflict" };
