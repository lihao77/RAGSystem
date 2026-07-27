export interface PostgresGoalMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_GOAL_MIGRATIONS: readonly PostgresGoalMigration[] = [
  {
    version: 1,
    name: "tenant_scoped_workflow_goals",
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_goals (
        tenant_id TEXT NOT NULL,
        goal_id UUID NOT NULL,
        session_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(success_criteria) = 'array'),
        steps JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(steps) = 'array'),
        checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(checkpoint) = 'object'),
        progress JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(progress) = 'object'),
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'completed', 'blocked')),
        continuation_count INTEGER NOT NULL DEFAULT 0,
        no_progress_count INTEGER NOT NULL DEFAULT 0,
        continuation_generation INTEGER NOT NULL DEFAULT 0,
        continuation_pending BOOLEAN NOT NULL DEFAULT FALSE,
        continuation_claimed_at TIMESTAMPTZ,
        last_progress_fingerprint TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, goal_id),
        FOREIGN KEY (tenant_id, session_id)
          REFERENCES conversation_sessions(tenant_id, session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS workflow_goals_tenant_session_created_idx
        ON workflow_goals(tenant_id, session_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS workflow_goals_tenant_session_current_idx
        ON workflow_goals(tenant_id, session_id)
        WHERE status IN ('active', 'paused');
    `,
  },
  {
    version: 2,
    name: "goal_continuation_reason",
    sql: `
      ALTER TABLE workflow_goals ADD COLUMN IF NOT EXISTS continuation_reason TEXT;
    `,
  },
];
