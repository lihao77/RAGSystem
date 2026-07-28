import type {
  ClaimGoalContinuationOptions,
  CreateGoalInput,
  Goal,
  GoalStore,
  GoalContinuationReason,
  UpdateGoalInput,
} from "@ragsystem/backend-core/contracts/runtime/goals.js";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";

type LocalGoalStoreSource = {
  getSession(sessionId: string): { tenant_id?: string | null | undefined } | null;
  createGoal(sessionId: string, input: CreateGoalInput): Promise<Goal> | Goal;
  getGoal(sessionId: string, goalId: string): Promise<Goal | null> | Goal | null;
  getCurrentGoal(sessionId: string): Promise<Goal | null> | Goal | null;
  updateGoal(sessionId: string, goalId: string, patch: UpdateGoalInput): Promise<Goal | null> | Goal | null;
  listGoals(sessionId: string): Promise<Goal[]> | Goal[];
  claimGoalContinuation(sessionId: string, options?: ClaimGoalContinuationOptions): Promise<Goal | null> | Goal | null;
  releaseGoalContinuation(sessionId: string, goalId: string, generation: number): Promise<boolean> | boolean;
  setContinuationReason?(sessionId: string, goalId: string, reason: GoalContinuationReason | null): Promise<Goal | null> | Goal | null;
  restartBlocked?(sessionId: string, goalId: string): Promise<Goal | null> | Goal | null;
};

/** Tenant ownership boundary over Local SQLite Goal persistence. */
export class LocalGoalStore implements GoalStore {
  constructor(
    private readonly tenantId: TenantId,
    private readonly source: LocalGoalStoreSource,
  ) {}

  async create(sessionId: string, input: CreateGoalInput): Promise<Goal> {
    this.assertOwnedSession(sessionId);
    return this.source.createGoal(sessionId, input);
  }

  async get(sessionId: string, goalId: string): Promise<Goal | null> {
    if (!this.ownsSession(sessionId)) return null;
    return this.source.getGoal(sessionId, goalId);
  }

  async getCurrent(sessionId: string): Promise<Goal | null> {
    if (!this.ownsSession(sessionId)) return null;
    return this.source.getCurrentGoal(sessionId);
  }

  async update(sessionId: string, goalId: string, patch: UpdateGoalInput): Promise<Goal | null> {
    if (!this.ownsSession(sessionId)) return null;
    return this.source.updateGoal(sessionId, goalId, patch);
  }

  async list(sessionId: string): Promise<Goal[]> {
    if (!this.ownsSession(sessionId)) return [];
    return this.source.listGoals(sessionId);
  }

  async claimContinuation(sessionId: string, options?: ClaimGoalContinuationOptions): Promise<Goal | null> {
    if (!this.ownsSession(sessionId)) return null;
    return this.source.claimGoalContinuation(sessionId, options);
  }

  async releaseContinuation(sessionId: string, goalId: string, generation: number): Promise<boolean> {
    if (!this.ownsSession(sessionId)) return false;
    return this.source.releaseGoalContinuation(sessionId, goalId, generation);
  }

  async setContinuationReason(sessionId: string, goalId: string, reason: GoalContinuationReason | null): Promise<Goal | null> {
    if (!this.ownsSession(sessionId) || !this.source.setContinuationReason) return null;
    return this.source.setContinuationReason(sessionId, goalId, reason);
  }

  async restartBlocked(sessionId: string, goalId: string): Promise<Goal | null> {
    if (!this.ownsSession(sessionId) || !this.source.restartBlocked) return null;
    return this.source.restartBlocked(sessionId, goalId);
  }

  private ownsSession(sessionId: string): boolean {
    return this.source.getSession(sessionId)?.tenant_id === this.tenantId;
  }

  private assertOwnedSession(sessionId: string): void {
    if (!this.ownsSession(sessionId)) {
      throw new Error(`会话 ${sessionId} 不存在或不属于当前租户`);
    }
  }
}
