import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolExecContext } from "@ragsystem/agent-sdk";
import { describe, expect, it } from "vitest";

import { createConversationStore } from "../../src/adapters/local/sqlite/conversation-store/index.js";
import { LocalWorkflowTaskStore } from "../../src/adapters/local/local-workflow-task-store.js";
import type {
  CreateWorkflowTaskInput,
  UpdateWorkflowTaskInput,
  WorkflowTask,
  WorkflowTaskStore,
} from "../../src/contracts/runtime/workflow-tasks.js";
import { BackgroundTaskService } from "../../src/services/runtime/background-task-service.js";
import { SessionNotificationQueue } from "../../src/services/runtime/session-notification-queue.js";
import { LOCAL_TENANT_ID } from "../../src/services/identity/index.js";
import { TaskToolService } from "../../src/tools/TaskTools/TaskExecution.js";
import { createTaskTools } from "../../src/tools/TaskTools/TaskTools.js";
import type { AgentConfig } from "../../src/contracts/agent/agent-config.js";
import { createTenantId } from "../../src/identity/types.js";

describe("durable local workflow tasks", () => {
  it("persists CRUD and dependency links across a database reopen", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "backend-ts-workflow-tasks-"));
    const dbPath = path.join(root, "conversation.db");
    let first: ReturnType<typeof createConversationStore> | null = null;
    let reopened: ReturnType<typeof createConversationStore> | null = null;
    try {
      first = createConversationStore({ dbPath, dataRoot: root });
      first.createSession(LOCAL_TENANT_ID, "session-a", "user-a");
      first.createSession(LOCAL_TENANT_ID, "session-b", "user-b");

      const blocker = first.createWorkflowTask("session-a", {
        subject: "Prepare",
        description: "Prepare inputs",
        metadata: { keep: true, remove: true },
      });
      const blocked = first.createWorkflowTask("session-a", {
        subject: "Execute",
        description: "Run the workflow",
      });
      const downstream = first.createWorkflowTask("session-a", {
        subject: "Publish",
        description: "Publish results",
      });
      const updated = first.updateWorkflowTask("session-a", blocked.id, {
        owner: "agent-a",
        status: "in_progress",
        addBlockedBy: [blocker.id],
        addBlocks: [downstream.id],
        metadata: { phase: 2 },
      });

      expect(updated).toMatchObject({
        id: blocked.id,
        owner: "agent-a",
        status: "in_progress",
        blocked_by: [blocker.id],
        blocks: [downstream.id],
        metadata: { phase: 2 },
      });
      expect(first.getWorkflowTask("session-a", blocker.id)?.blocks).toEqual([blocked.id]);
      expect(first.getWorkflowTask("session-a", downstream.id)?.blocked_by).toEqual([blocked.id]);
      expect(first.getWorkflowTask("session-b", blocker.id)).toBeNull();
      expect(first.listWorkflowTasks("session-a").map((task) => task.id)).toEqual([blocker.id, blocked.id, downstream.id]);

      first.close();
      first = null;
      reopened = createConversationStore({ dbPath, dataRoot: root });
      expect(reopened.getWorkflowTask("session-a", blocked.id)).toMatchObject({
        subject: "Execute",
        owner: "agent-a",
        status: "in_progress",
        blocked_by: [blocker.id],
        blocks: [downstream.id],
      });
      expect(reopened.deleteWorkflowTask("session-a", blocked.id)).toBe(true);
      expect(reopened.getWorkflowTask("session-a", blocked.id)).toBeNull();
      expect(reopened.getWorkflowTask("session-a", blocker.id)?.blocks).toEqual([]);
      expect(reopened.getWorkflowTask("session-a", downstream.id)?.blocked_by).toEqual([]);
    } finally {
      first?.close();
      reopened?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds the local adapter to the owning tenant", async () => {
    const store = createConversationStore({ dbPath: ":memory:", dataRoot: process.cwd() });
    const tenantA = createTenantId("tnt_workflow_a");
    const tenantB = createTenantId("tnt_workflow_b");
    try {
      store.createSession(tenantA, "session-a", "user-a");
      store.createSession(tenantB, "session-b", "user-b");
      const tenantAStore = new LocalWorkflowTaskStore(tenantA, store);
      const task = await tenantAStore.create("session-a", {
        subject: "Tenant A",
        description: "Owned by tenant A",
      });

      await expect(tenantAStore.get("session-b", task.id)).resolves.toBeNull();
      await expect(tenantAStore.list("session-b")).resolves.toEqual([]);
      await expect(tenantAStore.create("session-b", {
        subject: "Cross tenant",
        description: "Must fail",
      })).rejects.toThrow("不属于当前租户");
    } finally {
      store.close();
    }
  });
});

describe("workflow task id validation", () => {
  it.each(["../x", "0", "-1", "550e8400-e29b-41d4-a716-446655440000", "9223372036854775808"])(
    "rejects %s before calling persistence",
    async (taskId) => {
      const store = new RecordingWorkflowTaskStore();
      const service = new TaskToolService(
        new BackgroundTaskService(),
        new SessionNotificationQueue(),
        store,
      );
      const context = { sessionId: "session-a" } as ToolExecContext;

      const result = await service.taskGet({ taskId }, context);

      expect(result.success).toBe(false);
      expect(result.summary).toContain("task_id 必须是正整数任务 ID");
      expect(store.reads).toEqual([]);
    },
  );

  it("rejects invalid and self-referential dependency ids before updating", async () => {
    const store = new RecordingWorkflowTaskStore();
    const service = new TaskToolService(
      new BackgroundTaskService(),
      new SessionNotificationQueue(),
      store,
    );
    const context = { sessionId: "session-a" } as ToolExecContext;

    await expect(service.taskUpdate({ taskId: "1", addBlocks: ["../2"] }, context))
      .resolves.toMatchObject({ success: false });
    await expect(service.taskUpdate({ taskId: "1", addBlockedBy: ["1"] }, context))
      .resolves.toMatchObject({ success: false });
    expect(store.updates).toEqual([]);
  });

  it("keeps background task ids generic while workflow ids stay numeric", () => {
    const service = new TaskToolService(
      new BackgroundTaskService(),
      new SessionNotificationQueue(),
      new RecordingWorkflowTaskStore(),
    );
    const tools = createTaskTools({
      taskTools: service,
      agent: { tasks: { workflow: true, background: true } } as AgentConfig,
    });
    const workflowGet = tools.find((tool) => tool.name === "task_get");
    const backgroundStop = tools.find((tool) => tool.name === "task_stop");
    const backgroundId = "550e8400-e29b-41d4-a716-446655440000";

    expect(workflowGet?.inputSchema?.safeParse({ task_id: backgroundId }).success).toBe(false);
    expect(backgroundStop?.inputSchema?.safeParse({ task_id: backgroundId }).success).toBe(true);
  });
});

class RecordingWorkflowTaskStore implements WorkflowTaskStore {
  readonly reads: Array<{ sessionId: string; taskId: string }> = [];
  readonly updates: Array<{ sessionId: string; taskId: string }> = [];

  async create(_sessionId: string, _input: CreateWorkflowTaskInput): Promise<WorkflowTask> {
    throw new Error("not implemented");
  }

  async get(sessionId: string, taskId: string): Promise<WorkflowTask | null> {
    this.reads.push({ sessionId, taskId });
    return null;
  }

  async update(sessionId: string, taskId: string, _input: UpdateWorkflowTaskInput): Promise<WorkflowTask | null> {
    this.updates.push({ sessionId, taskId });
    return null;
  }

  async delete(_sessionId: string, _taskId: string): Promise<boolean> {
    return false;
  }

  async list(_sessionId: string): Promise<WorkflowTask[]> {
    return [];
  }
}
