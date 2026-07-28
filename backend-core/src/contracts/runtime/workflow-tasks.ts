export type WorkflowTaskStatus = "pending" | "in_progress" | "completed";

export interface WorkflowTask {
  id: string;
  subject: string;
  description: string;
  active_form: string;
  owner: string;
  status: WorkflowTaskStatus;
  blocks: string[];
  blocked_by: string[];
  metadata: Record<string, unknown>;
}

export interface CreateWorkflowTaskInput {
  subject: string;
  description: string;
  activeForm?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

export interface UpdateWorkflowTaskInput {
  subject?: string | null | undefined;
  description?: string | null | undefined;
  activeForm?: string | null | undefined;
  owner?: string | null | undefined;
  status?: WorkflowTaskStatus | null | undefined;
  addBlocks?: readonly string[] | null | undefined;
  addBlockedBy?: readonly string[] | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

/** Tenant-bound and session-bound durable workflow task persistence. */
export interface WorkflowTaskStore {
  create(sessionId: string, input: CreateWorkflowTaskInput): Promise<WorkflowTask>;
  get(sessionId: string, taskId: string): Promise<WorkflowTask | null>;
  update(sessionId: string, taskId: string, input: UpdateWorkflowTaskInput): Promise<WorkflowTask | null>;
  delete(sessionId: string, taskId: string): Promise<boolean>;
  list(sessionId: string): Promise<WorkflowTask[]>;
}

const MAX_WORKFLOW_TASK_ID = 9_223_372_036_854_775_807n;

export function isWorkflowTaskId(value: string): boolean {
  if (!/^[1-9]\d{0,18}$/.test(value)) {
    return false;
  }
  try {
    return BigInt(value) <= MAX_WORKFLOW_TASK_ID;
  } catch {
    return false;
  }
}

