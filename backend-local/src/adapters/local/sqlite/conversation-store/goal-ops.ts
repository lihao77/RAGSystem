import { createHash, randomUUID } from "node:crypto";

import type {
  ClaimGoalContinuationOptions,
  CreateGoalInput,
  Goal,
  GoalContinuationReason,
  GoalStatus,
  GoalStep,
  UpdateGoalInput,
} from "@ragsystem/backend-core/contracts/runtime/goals.js";
import { normalizeGoalSteps } from "@ragsystem/backend-core/contracts/runtime/goals.js";
import { runInTransaction } from "./shared/transaction.js";

interface GoalDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
  };
  exec(sql: string): void;
}

interface GoalRow {
  goal_id: string;
  session_id: string;
  objective: string;
  success_criteria: string;
  steps: string;
  checkpoint: string;
  progress: string;
  status: GoalStatus;
  continuation_count: number;
  no_progress_count: number;
  continuation_generation: number;
  continuation_pending: number;
  continuation_claimed_at: string | null;
  last_progress_fingerprint: string | null;
  continuation_reason: GoalContinuationReason | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `goal_id, session_id, objective, success_criteria, steps, checkpoint, progress,
  status, continuation_count, no_progress_count, continuation_generation, continuation_pending,
  continuation_claimed_at, last_progress_fingerprint, continuation_reason, created_at, updated_at`;

export class GoalOps {
  constructor(private readonly db: GoalDb) {}

  create(sessionId: string, input: CreateGoalInput): Goal {
    const goalId = randomUUID();
    const now = new Date().toISOString();
    const objective = required(input.objective, "objective");
    const successCriteria = cleanStrings(input.successCriteria);
    if (!successCriteria.length) throw new Error("successCriteria 至少需要一项");
    const steps = validateSteps(normalizeGoalSteps(input.steps));
    this.db.prepare(
      `INSERT INTO workflow_goals (
        goal_id, session_id, objective, success_criteria, steps, checkpoint, progress, status,
        continuation_count, no_progress_count, continuation_generation, continuation_pending,
        continuation_claimed_at, last_progress_fingerprint, continuation_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, NULL, NULL, ?, ?)`,
    ).run(
      goalId,
      sessionId,
      objective,
      JSON.stringify(successCriteria),
      JSON.stringify(steps),
      JSON.stringify(input.checkpoint ?? {}),
      JSON.stringify(input.progress ?? {}),
      "active",
      now,
      now,
    );
    return this.getRequired(sessionId, goalId);
  }

  get(sessionId: string, goalId: string): Goal | null {
    const row = this.db.prepare(
      `SELECT ${COLUMNS} FROM workflow_goals WHERE session_id=? AND goal_id=?`,
    ).get(sessionId, goalId) as GoalRow | undefined;
    return row ? toGoal(row) : null;
  }

  getCurrent(sessionId: string): Goal | null {
    const row = this.db.prepare(
      `SELECT ${COLUMNS} FROM workflow_goals
       WHERE session_id=? AND status IN ('active','paused')
       ORDER BY created_at DESC LIMIT 1`,
    ).get(sessionId) as GoalRow | undefined;
    return row ? toGoal(row) : null;
  }

  update(sessionId: string, goalId: string, input: UpdateGoalInput): Goal | null {
    const current = this.get(sessionId, goalId);
    if (!current) return null;
    const next = {
      objective: input.objective == null ? current.objective : required(input.objective, "objective"),
      successCriteria: input.successCriteria == null ? current.success_criteria : cleanStrings(input.successCriteria),
      steps: input.steps == null ? current.steps : validateSteps(normalizeGoalSteps(input.steps)),
      checkpoint: input.checkpoint ?? current.checkpoint,
      progress: input.progress ?? current.progress,
      status: input.status ?? current.status,
    };
    if (!next.successCriteria.length) throw new Error("successCriteria 至少需要一项");
    const continuationDisabled = next.status !== "active";
    this.db.prepare(
      `UPDATE workflow_goals SET
        objective=?, success_criteria=?, steps=?, checkpoint=?, progress=?, status=?,
        continuation_pending=CASE WHEN ? THEN 0 ELSE continuation_pending END,
        continuation_claimed_at=CASE WHEN ? THEN NULL ELSE continuation_claimed_at END,
        continuation_reason=CASE WHEN ?='paused' THEN 'manual_paused' WHEN ?='active' THEN NULL ELSE continuation_reason END,
        updated_at=?
       WHERE session_id=? AND goal_id=?`,
    ).run(
      next.objective,
      JSON.stringify(next.successCriteria),
      JSON.stringify(next.steps),
      JSON.stringify(next.checkpoint),
      JSON.stringify(next.progress),
      next.status,
      continuationDisabled ? 1 : 0,
      continuationDisabled ? 1 : 0,
      next.status,
      next.status,
      new Date().toISOString(),
      sessionId,
      goalId,
    );
    return this.getRequired(sessionId, goalId);
  }

  list(sessionId: string): Goal[] {
    return (this.db.prepare(
      `SELECT ${COLUMNS} FROM workflow_goals WHERE session_id=? ORDER BY created_at DESC`,
    ).all(sessionId) as GoalRow[]).map(toGoal);
  }

  claimContinuation(sessionId: string, input: ClaimGoalContinuationOptions = {}): Goal | null {
    return runInTransaction(this.db, () => {
      const current = this.getCurrent(sessionId);
      if (!current || current.status !== "active") return null;
      const nowMs = Date.now();
      const leaseTimeoutMs = positiveInt(input.leaseTimeoutMs, 120_000);
      const claimIsFresh = current.continuation_pending
        && current.continuation_claimed_at !== null
        && Number.isFinite(Date.parse(current.continuation_claimed_at))
        && nowMs - Date.parse(current.continuation_claimed_at) < leaseTimeoutMs;
      if (claimIsFresh) return null;

      const fingerprint = progressFingerprint(current);
      const noProgressCount = current.last_progress_fingerprint === null
        || current.last_progress_fingerprint !== fingerprint
        ? 0
        : current.no_progress_count + 1;
      const maxContinuations = positiveInt(input.maxContinuations, 20);
      const maxNoProgress = positiveInt(input.maxNoProgress, 3);
      if (current.continuation_count >= maxContinuations || noProgressCount >= maxNoProgress) {
        this.db.prepare(
          `UPDATE workflow_goals SET status='blocked', no_progress_count=?, continuation_pending=0,
             continuation_claimed_at=NULL, continuation_reason=?, last_progress_fingerprint=?, updated_at=?
           WHERE session_id=? AND goal_id=?`,
        ).run(noProgressCount, current.continuation_count >= maxContinuations ? "max_continuations" : "no_progress_guard", fingerprint, new Date(nowMs).toISOString(), sessionId, current.id);
        return null;
      }

      const generation = current.continuation_generation + 1;
      const updated = this.db.prepare(
        `UPDATE workflow_goals SET continuation_count=continuation_count+1, no_progress_count=?,
           continuation_generation=?, continuation_pending=1, continuation_claimed_at=?, continuation_reason=NULL,
           last_progress_fingerprint=?, updated_at=?
         WHERE session_id=? AND goal_id=? AND status='active'
           AND (continuation_pending=0 OR continuation_claimed_at IS NULL OR continuation_claimed_at=?)`,
      ).run(
        noProgressCount,
        generation,
        new Date(nowMs).toISOString(),
        fingerprint,
        new Date(nowMs).toISOString(),
        sessionId,
        current.id,
        current.continuation_claimed_at,
      );
      return Number(updated.changes) > 0 ? this.getRequired(sessionId, current.id) : null;
    });
  }

  releaseContinuation(sessionId: string, goalId: string, generation: number): boolean {
    const result = this.db.prepare(
      `UPDATE workflow_goals SET continuation_pending=0, continuation_claimed_at=NULL, updated_at=?
       WHERE session_id=? AND goal_id=? AND continuation_generation=? AND continuation_pending=1`,
    ).run(new Date().toISOString(), sessionId, goalId, generation);
    return Number(result.changes) > 0;
  }

  setContinuationReason(sessionId: string, goalId: string, reason: GoalContinuationReason | null): Goal | null {
    this.db.prepare(
      `UPDATE workflow_goals SET continuation_reason=?, updated_at=? WHERE session_id=? AND goal_id=?`,
    ).run(reason, new Date().toISOString(), sessionId, goalId);
    return this.get(sessionId, goalId);
  }

  restartBlocked(sessionId: string, goalId: string): Goal | null {
    this.db.prepare(
      `UPDATE workflow_goals SET status='active', continuation_count=0, no_progress_count=0,
         continuation_generation=continuation_generation+1, continuation_pending=0,
         continuation_claimed_at=NULL, continuation_reason=NULL, last_progress_fingerprint=NULL,
         updated_at=? WHERE session_id=? AND goal_id=? AND status='blocked'`,
    ).run(new Date().toISOString(), sessionId, goalId);
    return this.get(sessionId, goalId);
  }

  private getRequired(sessionId: string, goalId: string): Goal {
    const goal = this.get(sessionId, goalId);
    if (!goal) throw new Error(`goal insert/update failed: ${goalId}`);
    return goal;
  }
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.goal_id,
    session_id: row.session_id,
    objective: row.objective,
    success_criteria: parseJson<string[]>(row.success_criteria, []),
    steps: parseJson<Goal["steps"]>(row.steps, []),
    checkpoint: parseJson<Record<string, unknown>>(row.checkpoint, {}),
    progress: parseJson<Record<string, unknown>>(row.progress, {}),
    status: row.status,
    continuation_count: Number(row.continuation_count),
    no_progress_count: Number(row.no_progress_count),
    continuation_generation: Number(row.continuation_generation),
    continuation_pending: Boolean(row.continuation_pending),
    continuation_claimed_at: row.continuation_claimed_at,
    continuation_reason: row.continuation_reason,
    last_progress_fingerprint: row.last_progress_fingerprint,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function progressFingerprint(goal: Goal): string {
  return createHash("sha256")
    .update(stableJson({ steps: goal.steps, checkpoint: goal.checkpoint, progress: goal.progress }))
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} 不能为空`);
  return normalized;
}

function cleanStrings(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function validateSteps(steps: GoalStep[]): GoalStep[] {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id || !step.title) throw new Error("Goal step 必须包含 id 和 title");
    if (ids.has(step.id)) throw new Error(`Goal step id 重复: ${step.id}`);
    ids.add(step.id);
  }
  return steps;
}
