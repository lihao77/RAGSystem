export type GoalStatus = "active" | "paused" | "completed" | "blocked";

export type GoalStepStatus = "pending" | "in_progress" | "completed" | "blocked";

export interface GoalStep {
  id: string;
  title: string;
  description: string;
  status: GoalStepStatus;
  evidence: string | null;
}

/** A durable, session-scoped objective that may span multiple agent runs. */
export interface Goal {
  id: string;
  session_id: string;
  objective: string;
  success_criteria: string[];
  steps: GoalStep[];
  checkpoint: Record<string, unknown>;
  progress: Record<string, unknown>;
  status: GoalStatus;
  continuation_count: number;
  no_progress_count: number;
  continuation_generation: number;
  continuation_pending: boolean;
  continuation_claimed_at: string | null;
  last_progress_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateGoalInput {
  objective: string;
  successCriteria: readonly string[];
  steps?: readonly GoalStep[] | null | undefined;
  checkpoint?: Record<string, unknown> | null | undefined;
  progress?: Record<string, unknown> | null | undefined;
}

/** Publicly mutable fields. Continuation counters and fingerprints are store-owned. */
export interface UpdateGoalInput {
  objective?: string | null | undefined;
  successCriteria?: readonly string[] | null | undefined;
  steps?: readonly GoalStep[] | null | undefined;
  checkpoint?: Record<string, unknown> | null | undefined;
  progress?: Record<string, unknown> | null | undefined;
  status?: GoalStatus | null | undefined;
}

export interface ClaimGoalContinuationOptions {
  maxContinuations?: number | undefined;
  maxNoProgress?: number | undefined;
  leaseTimeoutMs?: number | undefined;
}

/** Tenant-bound, session-bound persistence and atomic continuation coordination. */
export interface GoalStore {
  create(sessionId: string, input: CreateGoalInput): Promise<Goal>;
  get(sessionId: string, goalId: string): Promise<Goal | null>;
  /** Returns the session's active or paused Goal, if any. */
  getCurrent(sessionId: string): Promise<Goal | null>;
  update(sessionId: string, goalId: string, patch: UpdateGoalInput): Promise<Goal | null>;
  list(sessionId: string): Promise<Goal[]>;
  /** Atomically reserves the next automatic continuation; returns null when unavailable or guarded. */
  claimContinuation(sessionId: string, options?: ClaimGoalContinuationOptions): Promise<Goal | null>;
  /** Releases a matching continuation reservation after run start failure or run completion. */
  releaseContinuation(sessionId: string, goalId: string, generation: number): Promise<boolean>;
}

export function normalizeGoalSteps(steps: readonly GoalStep[] | null | undefined): GoalStep[] {
  return (steps ?? []).map((step, index) => ({
    id: step.id.trim() || String(index + 1),
    title: step.title.trim(),
    description: step.description.trim(),
    status: step.status,
    evidence: step.evidence?.trim() || null,
  }));
}

export function isGoalId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
