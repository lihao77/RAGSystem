export type MemoryCandidateTargetScope = "team" | "agent";
export type MemoryCandidateStatus = "candidate" | "approved" | "rejected" | "withdrawn";
export type MemoryCandidateOperation = "publish" | "archive";

export interface MemoryCandidateRecord {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  target_scope: MemoryCandidateTargetScope;
  operation: MemoryCandidateOperation;
  target_file_name: string | null;
  team_name: string;
  agent_name: string | null;
  name: string;
  description: string;
  memory_type: string;
  content: string;
  why: string | null;
  how_to_apply: string | null;
  status: MemoryCandidateStatus;
  source_session_id: string | null;
  source_run_id: string | null;
  source_message_id: string | null;
  reviewer_user_id: string | null;
  review_comment: string | null;
  published_file_name: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  review_claimed_at: string | null;
  review_attempt_id: string | null;
}

export interface ListMemoryCandidatesInput {
  ownerUserId?: string | null;
  statuses?: MemoryCandidateStatus[];
  targetScope?: MemoryCandidateTargetScope | null;
  targetScopes?: MemoryCandidateTargetScope[];
  teamName?: string | null;
  agentName?: string | null;
  operation?: MemoryCandidateOperation | null;
  limit?: number;
  offset?: number;
  contentMaxChars?: number;
}

export interface CreateMemoryCandidateInput {
  tenantId: string;
  ownerUserId: string;
  targetScope: MemoryCandidateTargetScope;
  operation?: MemoryCandidateOperation;
  teamName: string;
  agentName?: string | null;
  name: string;
  description: string;
  memoryType: string;
  content: string;
  why?: string | null;
  howToApply?: string | null;
  sourceSessionId?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
  targetFileName?: string | null;
}
