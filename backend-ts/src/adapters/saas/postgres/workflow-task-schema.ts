export interface PostgresWorkflowTaskMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_WORKFLOW_TASK_MIGRATIONS: readonly PostgresWorkflowTaskMigration[] = [
  {
    version: 1,
    name: "tenant_scoped_workflow_tasks",
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_tasks (
        tenant_id TEXT NOT NULL,
        task_id BIGSERIAL NOT NULL,
        session_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        active_form TEXT NOT NULL DEFAULT '',
        owner TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed')),
        blocks JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(blocks) = 'array'),
        blocked_by JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(blocked_by) = 'array'),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, task_id),
        FOREIGN KEY (tenant_id, session_id)
          REFERENCES conversation_sessions(tenant_id, session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS workflow_tasks_tenant_session_task_idx
        ON workflow_tasks(tenant_id, session_id, task_id);
    `,
  },
];
