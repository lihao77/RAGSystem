import type {
  CreateWorkflowTaskInput,
  UpdateWorkflowTaskInput,
  WorkflowTask,
  WorkflowTaskStore,
} from "../../contracts/runtime/workflow-tasks.js";
import type { TenantId } from "../../identity/types.js";

type LocalWorkflowTaskStoreSource = {
  getSession(sessionId: string): { tenant_id?: string | null | undefined } | null;
  createWorkflowTask(sessionId: string, input: CreateWorkflowTaskInput): WorkflowTask;
  getWorkflowTask(sessionId: string, taskId: string): WorkflowTask | null;
  updateWorkflowTask(sessionId: string, taskId: string, input: UpdateWorkflowTaskInput): WorkflowTask | null;
  deleteWorkflowTask(sessionId: string, taskId: string): boolean;
  listWorkflowTasks(sessionId: string): WorkflowTask[];
};

/** Promise boundary over Local SQLite workflow task persistence. */
export class LocalWorkflowTaskStore implements WorkflowTaskStore {
  constructor(
    private readonly tenantId: TenantId,
    private readonly source: LocalWorkflowTaskStoreSource,
  ) {}

  async create(sessionId: string, input: CreateWorkflowTaskInput): Promise<WorkflowTask> {
    this.assertOwnedSession(sessionId);
    return this.source.createWorkflowTask(sessionId, input);
  }

  async get(sessionId: string, taskId: string): Promise<WorkflowTask | null> {
    if (!this.ownsSession(sessionId)) return null;
    return this.source.getWorkflowTask(sessionId, taskId);
  }

  async update(sessionId: string, taskId: string, input: UpdateWorkflowTaskInput): Promise<WorkflowTask | null> {
    if (!this.ownsSession(sessionId)) return null;
    return this.source.updateWorkflowTask(sessionId, taskId, input);
  }

  async delete(sessionId: string, taskId: string): Promise<boolean> {
    if (!this.ownsSession(sessionId)) return false;
    return this.source.deleteWorkflowTask(sessionId, taskId);
  }

  async list(sessionId: string): Promise<WorkflowTask[]> {
    if (!this.ownsSession(sessionId)) return [];
    return this.source.listWorkflowTasks(sessionId);
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
