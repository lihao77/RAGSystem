import { createHash, randomUUID } from "node:crypto";

import type {
  ClaimGoalContinuationOptions,
  CreateGoalInput,
  Goal,
  GoalContinuationReason,
  GoalStatus,
  GoalStep,
  GoalStore,
  UpdateGoalInput,
} from "@ragsystem/backend-core/contracts/runtime/goals.js";
import { normalizeGoalSteps } from "@ragsystem/backend-core/contracts/runtime/goals.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { PostgresExecutor } from "./postgres-executor.js";

const COLUMNS = `
  goal_id::text AS goal_id, session_id, objective, success_criteria, steps, checkpoint, progress, status,
  continuation_count, no_progress_count, continuation_generation, continuation_pending,
  continuation_claimed_at, last_progress_fingerprint, continuation_reason, created_at, updated_at
`;

/** Tenant-bound PostgreSQL implementation for session Goals. */
export class PostgresGoalRepository implements GoalStore {
  constructor(
    private readonly tenantId: TenantId,
    private readonly executor: PostgresExecutor,
  ) {}

  async create(sessionId: string, input: CreateGoalInput): Promise<Goal> {
    const objective = required(input.objective, "objective");
    const successCriteria = requiredCriteria(input.successCriteria);
    const steps = validateSteps(normalizeGoalSteps(input.steps));
    try {
      const result = await this.executor.query(
        `INSERT INTO workflow_goals (
          tenant_id, goal_id, session_id, objective, success_criteria, steps, checkpoint, progress, status
        ) VALUES ($1,$2::uuid,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,'active')
        RETURNING ${COLUMNS}`,
        [this.tenantId, randomUUID(), sessionId, objective, JSON.stringify(successCriteria), JSON.stringify(steps),
          JSON.stringify(input.checkpoint ?? {}), JSON.stringify(input.progress ?? {})],
      );
      if (!result.rows[0]) throw new Error("Goal insert returned no row");
      return toGoal(result.rows[0]);
    } catch (error) {
      if (String(error).includes("workflow_goals_tenant_session_current_idx")) {
        throw new Error(`会话 ${sessionId} 已存在进行中或已暂停的 Goal`);
      }
      throw error;
    }
  }

  async get(sessionId: string, goalId: string): Promise<Goal | null> {
    const result = await this.executor.query(
      `SELECT ${COLUMNS} FROM workflow_goals WHERE tenant_id=$1 AND session_id=$2 AND goal_id=$3::uuid`,
      [this.tenantId, sessionId, goalId],
    );
    return result.rows[0] ? toGoal(result.rows[0]) : null;
  }

  async getCurrent(sessionId: string): Promise<Goal | null> {
    const result = await this.executor.query(
      `SELECT ${COLUMNS} FROM workflow_goals
       WHERE tenant_id=$1 AND session_id=$2 AND status IN ('active', 'paused')
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      [this.tenantId, sessionId],
    );
    return result.rows[0] ? toGoal(result.rows[0]) : null;
  }

  async update(sessionId: string, goalId: string, patch: UpdateGoalInput): Promise<Goal | null> {
    return this.executor.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT ${COLUMNS} FROM workflow_goals
         WHERE tenant_id=$1 AND session_id=$2 AND goal_id=$3::uuid FOR UPDATE`,
        [this.tenantId, sessionId, goalId],
      );
      if (!locked.rows[0]) return null;
      const current = toGoal(locked.rows[0]);
      const next = applyUpdate(current, patch);
      const clearClaim = next.status !== "active";
      const updated = await tx.query(
        `UPDATE workflow_goals SET objective=$1, success_criteria=$2::jsonb, steps=$3::jsonb,
           checkpoint=$4::jsonb, progress=$5::jsonb, status=$6,
           continuation_pending=$7, continuation_claimed_at=$8, continuation_reason=$9, updated_at=CURRENT_TIMESTAMP
         WHERE tenant_id=$10 AND session_id=$11 AND goal_id=$12::uuid RETURNING ${COLUMNS}`,
        [next.objective, JSON.stringify(next.success_criteria), JSON.stringify(next.steps), JSON.stringify(next.checkpoint),
          JSON.stringify(next.progress), next.status, clearClaim ? false : current.continuation_pending,
          clearClaim ? null : current.continuation_claimed_at,
          patch.status === "active" ? null : patch.status === "paused" ? "manual_paused" : current.continuation_reason,
          this.tenantId, sessionId, goalId],
      );
      return updated.rows[0] ? toGoal(updated.rows[0]) : null;
    });
  }

  async list(sessionId: string): Promise<Goal[]> {
    const result = await this.executor.query(
      `SELECT ${COLUMNS} FROM workflow_goals
       WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at DESC, goal_id DESC`,
      [this.tenantId, sessionId],
    );
    return result.rows.map(toGoal);
  }

  async claimContinuation(sessionId: string, options: ClaimGoalContinuationOptions = {}): Promise<Goal | null> {
    const maxContinuations = positiveInteger(options.maxContinuations, 20);
    const maxNoProgress = positiveInteger(options.maxNoProgress, 3);
    const leaseTimeoutMs = positiveInteger(options.leaseTimeoutMs, 120_000);
    return this.executor.transaction(async (tx) => {
      const locked = await tx.query(
        `SELECT ${COLUMNS} FROM workflow_goals
         WHERE tenant_id=$1 AND session_id=$2 AND status='active' LIMIT 1 FOR UPDATE`,
        [this.tenantId, sessionId],
      );
      if (!locked.rows[0]) return null;
      const current = toGoal(locked.rows[0]);
      if (current.continuation_pending && !claimExpired(current.continuation_claimed_at, leaseTimeoutMs)) return null;
      if (current.continuation_count >= maxContinuations) {
        await blockForGuard(tx, this.tenantId, sessionId, current.id, current.no_progress_count, "max_continuations");
        return null;
      }
      const fingerprint = progressFingerprint(current);
      const noProgressCount = current.last_progress_fingerprint === fingerprint ? current.no_progress_count + 1 : 0;
      if (noProgressCount >= maxNoProgress) {
        await blockForGuard(tx, this.tenantId, sessionId, current.id, noProgressCount, "no_progress_guard");
        return null;
      }
      const updated = await tx.query(
        `UPDATE workflow_goals SET continuation_count=continuation_count+1, no_progress_count=$1,
           continuation_generation=continuation_generation+1, continuation_pending=TRUE, continuation_reason=NULL,
           continuation_claimed_at=CURRENT_TIMESTAMP, last_progress_fingerprint=$2, updated_at=CURRENT_TIMESTAMP
         WHERE tenant_id=$3 AND session_id=$4 AND goal_id=$5::uuid AND status='active' RETURNING ${COLUMNS}`,
        [noProgressCount, fingerprint, this.tenantId, sessionId, current.id],
      );
      return updated.rows[0] ? toGoal(updated.rows[0]) : null;
    });
  }

  async releaseContinuation(sessionId: string, goalId: string, generation: number): Promise<boolean> {
    const result = await this.executor.query(
      `UPDATE workflow_goals SET continuation_pending=FALSE, continuation_claimed_at=NULL, updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$1 AND session_id=$2 AND goal_id=$3::uuid
         AND continuation_generation=$4 AND continuation_pending=TRUE`,
      [this.tenantId, sessionId, goalId, generation],
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async setContinuationReason(sessionId: string, goalId: string, reason: GoalContinuationReason | null): Promise<Goal | null> {
    const result = await this.executor.query(
      `UPDATE workflow_goals SET continuation_reason=$1, updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$2 AND session_id=$3 AND goal_id=$4::uuid RETURNING ${COLUMNS}`,
      [reason, this.tenantId, sessionId, goalId],
    );
    return result.rows[0] ? toGoal(result.rows[0]) : null;
  }

  async restartBlocked(sessionId: string, goalId: string): Promise<Goal | null> {
    const result = await this.executor.query(
      `UPDATE workflow_goals SET status='active', continuation_count=0, no_progress_count=0,
         continuation_generation=continuation_generation+1, continuation_pending=FALSE,
         continuation_claimed_at=NULL, continuation_reason=NULL, last_progress_fingerprint=NULL,
         updated_at=CURRENT_TIMESTAMP
       WHERE tenant_id=$1 AND session_id=$2 AND goal_id=$3::uuid AND status='blocked'
       RETURNING ${COLUMNS}`,
      [this.tenantId, sessionId, goalId],
    );
    return result.rows[0] ? toGoal(result.rows[0]) : null;
  }
}

async function blockForGuard(executor: PostgresExecutor, tenantId: TenantId, sessionId: string, goalId: string, count: number, reason: GoalContinuationReason): Promise<void> {
  await executor.query(
    `UPDATE workflow_goals SET status='blocked', no_progress_count=$1, continuation_pending=FALSE,
       continuation_reason=$5,
       continuation_claimed_at=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE tenant_id=$2 AND session_id=$3 AND goal_id=$4::uuid`,
    [count, tenantId, sessionId, goalId, reason],
  );
}

function toGoal(row: Record<string, unknown>): Goal {
  return {
    id: String(row.goal_id), session_id: String(row.session_id), objective: String(row.objective),
    success_criteria: stringArray(row.success_criteria), steps: goalSteps(row.steps),
    checkpoint: record(row.checkpoint), progress: record(row.progress), status: row.status as GoalStatus,
    continuation_count: Number(row.continuation_count), no_progress_count: Number(row.no_progress_count),
    continuation_generation: Number(row.continuation_generation), continuation_pending: Boolean(row.continuation_pending),
    continuation_claimed_at: isoOrNull(row.continuation_claimed_at),
    continuation_reason: isContinuationReason(row.continuation_reason) ? row.continuation_reason : null,
    last_progress_fingerprint: row.last_progress_fingerprint == null ? null : String(row.last_progress_fingerprint),
    created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString(),
  };
}

function applyUpdate(goal: Goal, patch: UpdateGoalInput): Goal {
  const next = structuredClone(goal) as Goal;
  if (patch.objective != null) next.objective = required(patch.objective, "objective");
  if (patch.successCriteria != null) next.success_criteria = requiredCriteria(patch.successCriteria);
  if (patch.steps != null) next.steps = validateSteps(normalizeGoalSteps(patch.steps));
  if (patch.checkpoint != null) next.checkpoint = { ...patch.checkpoint };
  if (patch.progress != null) next.progress = { ...patch.progress };
  if (patch.status != null) next.status = patch.status;
  return next;
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

function claimExpired(claimedAt: string | null, timeoutMs: number): boolean {
  if (!claimedAt) return true;
  const timestamp = Date.parse(claimedAt);
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= timeoutMs;
}

function required(value: string, name: string): string { const result = value.trim(); if (!result) throw new Error(`${name} 不能为空`); return result; }
function cleanStrings(values: readonly string[]): string[] { return values.map((value) => value.trim()).filter(Boolean); }
function requiredCriteria(values: readonly string[]): string[] {
  const result = cleanStrings(values);
  if (!result.length) throw new Error("successCriteria 至少需要一项");
  return result;
}
function positiveInteger(value: number | undefined, fallback: number): number { return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback; }

function validateSteps(steps: GoalStep[]): GoalStep[] {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!step.id || !step.title) throw new Error("Goal step 必须包含 id 和 title");
    if (ids.has(step.id)) throw new Error(`Goal step id 重复: ${step.id}`);
    ids.add(step.id);
  }
  return steps;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return record(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}
function stringArray(value: unknown): string[] {
  if (typeof value === "string") { try { return stringArray(JSON.parse(value)); } catch { return []; } }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
function goalSteps(value: unknown): GoalStep[] {
  if (typeof value === "string") { try { return goalSteps(JSON.parse(value)); } catch { return []; } }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const step = entry as Record<string, unknown>; const status = String(step.status ?? "pending");
    if (!["pending", "in_progress", "completed", "blocked"].includes(status)) return [];
    return [{ id: String(step.id ?? ""), title: String(step.title ?? ""), description: String(step.description ?? ""),
      status: status as GoalStep["status"], evidence: typeof step.evidence === "string" ? step.evidence : null }];
  });
}
function isoOrNull(value: unknown): string | null { return value == null ? null : new Date(String(value)).toISOString(); }
function isContinuationReason(value: unknown): value is GoalContinuationReason {
  return typeof value === "string" && [
    "manual_paused", "run_still_running", "background_tasks_running", "goal_not_active",
    "readiness_failed", "max_continuations", "no_progress_guard", "continuation_pending",
    "continuation_start_failed",
  ].includes(value);
}
