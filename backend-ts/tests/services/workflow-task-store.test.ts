import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolExecContext } from "@ragsystem/agent-sdk";
import { describe, expect, it } from "vitest";

import { LocalGoalStore } from "../../src/adapters/local/local-goal-store.js";
import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import type {
  ClaimGoalContinuationOptions,
  CreateGoalInput,
  Goal,
  GoalStore,
  UpdateGoalInput,
} from "../../src/contracts/runtime/goals.js";
import type { AgentConfig } from "../../src/contracts/agent/agent-config.js";
import { createTenantId } from "../../src/identity/types.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { BackgroundTaskService } from "../../src/services/runtime/background-task-service.js";
import { SessionNotificationQueue } from "../../src/services/runtime/session-notification-queue.js";
import { TaskToolService } from "../../src/tools/TaskTools/TaskExecution.js";
import { createTaskTools } from "../../src/tools/TaskTools/TaskTools.js";

describe("durable local Goals", () => {
  it("persists Goal lifecycle and permits only one current Goal per session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-ts-goals-"));
    const dbPath = path.join(root, "conversation.db");
    let first: ReturnType<typeof createConversationStore> | null = null;
    let reopened: ReturnType<typeof createConversationStore> | null = null;
    try {
      first = createConversationStore({ dbPath, dataRoot: root });
      first.createSession(LOCAL_TENANT_ID, "session-a", "user-a");
      const goal = first.createGoal("session-a", {
        objective: "Ship Goal mode",
        successCriteria: ["tests pass"],
        steps: [{ id: "1", title: "Implement", description: "Build it", status: "in_progress", evidence: null }],
      });
      expect(first.getCurrentGoal("session-a")).toMatchObject({ id: goal.id, status: "active" });
      expect(() => first!.createGoal("session-a", { objective: "Second", successCriteria: ["done"] })).toThrow();

      expect(first.updateGoal("session-a", goal.id, {
        checkpoint: { files: ["src/goal.ts"] },
        progress: { summary: "implemented" },
        steps: [{ id: "1", title: "Implement", description: "Build it", status: "completed", evidence: "tests" }],
        status: "completed",
      })).toMatchObject({ status: "completed", progress: { summary: "implemented" } });
      const next = first.createGoal("session-a", { objective: "Document it", successCriteria: ["docs published"] });

      first.close();
      first = null;
      reopened = createConversationStore({ dbPath, dataRoot: root });
      expect(reopened.getCurrentGoal("session-a")).toMatchObject({ id: next.id, status: "active" });
      expect(reopened.listGoals("session-a")).toHaveLength(2);
    } finally {
      first?.close();
      reopened?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically claims, releases, and guards automatic continuation", () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      store.createSession(LOCAL_TENANT_ID, "session-a", "user-a");
      const goal = store.createGoal("session-a", { objective: "Finish", successCriteria: ["verified"] });
      const first = store.claimGoalContinuation("session-a");
      expect(first).toMatchObject({ continuation_count: 1, continuation_generation: 1, continuation_pending: true });
      expect(store.claimGoalContinuation("session-a")).toBeNull();
      expect(store.releaseGoalContinuation("session-a", goal.id, 1)).toBe(true);
      expect(store.claimGoalContinuation("session-a", { maxContinuations: 1 })).toBeNull();
      expect(store.getGoal("session-a", goal.id)?.status).toBe("blocked");

      store.createSession(LOCAL_TENANT_ID, "session-b", "user-b");
      const stalled = store.createGoal("session-b", { objective: "Detect no progress", successCriteria: ["verified"] });
      for (let generation = 1; generation <= 3; generation += 1) {
        const claim = store.claimGoalContinuation("session-b", { maxNoProgress: 3 });
        expect(claim?.continuation_generation).toBe(generation);
        expect(store.releaseGoalContinuation("session-b", stalled.id, generation)).toBe(true);
      }
      expect(store.claimGoalContinuation("session-b", { maxNoProgress: 3 })).toBeNull();
      expect(store.getGoal("session-b", stalled.id)).toMatchObject({ status: "blocked", no_progress_count: 3 });
    } finally {
      store.close();
    }
  });

  it("binds the local adapter to the owning tenant", async () => {
    const source = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const tenantA = createTenantId("tnt_goal_a");
    const tenantB = createTenantId("tnt_goal_b");
    try {
      source.createSession(tenantA, "session-a", "user-a");
      source.createSession(tenantB, "session-b", "user-b");
      const store = new LocalGoalStore(tenantA, source);
      const goal = await store.create("session-a", { objective: "Tenant A Goal", successCriteria: ["done"] });
      await expect(store.get("session-b", goal.id)).resolves.toBeNull();
      await expect(store.list("session-b")).resolves.toEqual([]);
      await expect(store.create("session-b", { objective: "Cross tenant", successCriteria: ["must fail"] }))
        .rejects.toThrow("不属于当前租户");
    } finally {
      source.close();
    }
  });
});

describe("Goal tools", () => {
  it("does not let an Agent revive a completed Goal through an explicit historical id", async () => {
    const source = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    try {
      source.createSession(LOCAL_TENANT_ID, "session-terminal", "user-a");
      const goals = new LocalGoalStore(LOCAL_TENANT_ID, source);
      const goal = await goals.create("session-terminal", {
        objective: "Keep history terminal",
        successCriteria: ["completed remains completed"],
      });
      await goals.update("session-terminal", goal.id, { status: "completed" });
      const service = new TaskToolService(new BackgroundTaskService(), new SessionNotificationQueue(), goals);

      const result = await service.goalUpdate(
        { goalId: goal.id, status: "paused" },
        { sessionId: "session-terminal" } as ToolExecContext,
      );

      expect(result).toMatchObject({ success: false });
      await expect(goals.get("session-terminal", goal.id)).resolves.toMatchObject({ status: "completed" });
    } finally {
      source.close();
    }
  });

  it("validates Goal ids without restricting background task ids", async () => {
    const goals = new RecordingGoalStore();
    const service = new TaskToolService(new BackgroundTaskService(), new SessionNotificationQueue(), goals);
    const context = { sessionId: "session-a" } as ToolExecContext;
    const result = await service.goalGet({ goalId: "../x" }, context);
    expect(result).toMatchObject({ success: false });
    expect(goals.reads).toEqual([]);

    const tools = createTaskTools({ taskTools: service, agent: { goals: { enabled: true }, tasks: { background: true } } as AgentConfig });
    const goalCreate = tools.find((tool) => tool.name === "goal_create");
    const goalGet = tools.find((tool) => tool.name === "goal_get");
    const backgroundStop = tools.find((tool) => tool.name === "task_stop");
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(goalCreate?.inputSchema?.safeParse({ objective: "Ship", success_criteria: ["verified"] }).success).toBe(true);
    expect(goalGet?.inputSchema?.safeParse({ goal_id: uuid }).success).toBe(true);
    expect(backgroundStop?.inputSchema?.safeParse({ task_id: uuid }).success).toBe(true);
    expect(tools.map((tool) => tool.name)).not.toContain("task_create");
  });
});

class RecordingGoalStore implements GoalStore {
  readonly reads: Array<{ sessionId: string; goalId: string }> = [];
  async create(_sessionId: string, _input: CreateGoalInput): Promise<Goal> { throw new Error("not implemented"); }
  async get(sessionId: string, goalId: string): Promise<Goal | null> { this.reads.push({ sessionId, goalId }); return null; }
  async getCurrent(_sessionId: string): Promise<Goal | null> { return null; }
  async update(_sessionId: string, _goalId: string, _patch: UpdateGoalInput): Promise<Goal | null> { return null; }
  async list(_sessionId: string): Promise<Goal[]> { return []; }
  async claimContinuation(_sessionId: string, _options?: ClaimGoalContinuationOptions): Promise<Goal | null> { return null; }
  async releaseContinuation(_sessionId: string, _goalId: string, _generation: number): Promise<boolean> { return false; }
}
