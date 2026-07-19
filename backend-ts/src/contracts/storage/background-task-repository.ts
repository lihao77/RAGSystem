export type DurableBackgroundTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface DurableBackgroundTaskRecord {
  tenant_id: string;
  task_id: string;
  description: string;
  output_path: string;
  started_at: number;
  status: DurableBackgroundTaskStatus;
  return_code: number | null;
  error: string | null;
  expires_at: number | null;
  run_id: string | null;
  owner_task_id: string | null;
  session_id: string | null;
  completed_at: number | null;
  result_type: string | null;
  kind: string;
  cancel_supported: boolean;
  owner_instance_id: string | null;
  lease_expires_at: number | null;
}

export interface AsyncBackgroundTaskRepository {
  upsert(task: DurableBackgroundTaskRecord): Promise<void>;
  listActive(tenantId: string, now: number): Promise<DurableBackgroundTaskRecord[]>;
  failExpiredRunning(tenantId: string, now: number, error: string): Promise<string[]>;
  deleteExpired(tenantId: string, now: number): Promise<number>;
}
