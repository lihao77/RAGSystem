export interface PostgresBackgroundTaskMigration { version: number; name: string; sql: string; }

export const POSTGRES_BACKGROUND_TASK_MIGRATIONS: readonly PostgresBackgroundTaskMigration[] = [{
  version: 1,
  name: "background-task-metadata",
  sql: `
    CREATE TABLE IF NOT EXISTS saas_background_tasks (
      tenant_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      description TEXT NOT NULL,
      output_path TEXT NOT NULL,
      started_at DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      return_code INTEGER,
      error TEXT,
      expires_at DOUBLE PRECISION,
      run_id TEXT,
      owner_task_id TEXT,
      session_id TEXT,
      completed_at DOUBLE PRECISION,
      result_type TEXT,
      kind TEXT NOT NULL,
      cancel_supported BOOLEAN NOT NULL DEFAULT FALSE,
      owner_instance_id TEXT,
      lease_expires_at DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant_id, task_id)
    );
    CREATE INDEX IF NOT EXISTS saas_background_tasks_session_idx
      ON saas_background_tasks (tenant_id, session_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS saas_background_tasks_lease_idx
      ON saas_background_tasks (tenant_id, status, lease_expires_at)
      WHERE status = 'running';
  `,
}];
