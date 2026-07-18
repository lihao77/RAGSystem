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
}

export interface ApprovePersistedMemoryCandidateInput {
  tenant_id: string;
  candidate_id: string;
  reviewer_user_id: string;
  expected_version: number;
  review_comment?: string | null;
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
