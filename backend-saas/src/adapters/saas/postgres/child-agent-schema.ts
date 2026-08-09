export interface PostgresChildAgentMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_CHILD_AGENT_MIGRATIONS: readonly PostgresChildAgentMigration[] = [
  {
    version: 1,
    name: "tenant-scoped-child-agents",
    sql: `
      CREATE TABLE IF NOT EXISTS saas_child_agents (
        tenant_id TEXT NOT NULL,
        child_agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        parent_participant_id TEXT,
        created_seq BIGINT,
        created_by_run_id TEXT,
        created_by_call_id TEXT,
        parent_run_id TEXT,
        parent_call_id TEXT,
        last_run_id TEXT,
        -- last_run_id is recorded before the run engine creates its run row.
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, child_agent_id),
        FOREIGN KEY (tenant_id, session_id)
          REFERENCES conversation_sessions(tenant_id, session_id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, parent_run_id)
          REFERENCES saas_runs(tenant_id, run_id),
        CHECK (jsonb_typeof(metadata) = 'object')
      );
      CREATE INDEX IF NOT EXISTS saas_child_agents_session_created_idx
        ON saas_child_agents(tenant_id, session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS saas_child_agents_session_agent_idx
        ON saas_child_agents(tenant_id, session_id, agent_name, created_at DESC);
      CREATE INDEX IF NOT EXISTS saas_child_agents_parent_idx
        ON saas_child_agents(tenant_id, session_id, parent_participant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS saas_child_agents_creator_idx
        ON saas_child_agents(tenant_id, session_id, created_by_run_id, created_by_call_id)
        WHERE created_by_run_id IS NOT NULL AND created_by_call_id IS NOT NULL;
    `,
  },
  {
    version: 2,
    name: "child-agent-parent-participant",
    sql: `
      ALTER TABLE saas_child_agents ADD COLUMN IF NOT EXISTS parent_participant_id TEXT;
      CREATE INDEX IF NOT EXISTS saas_child_agents_parent_idx
        ON saas_child_agents(tenant_id, session_id, parent_participant_id, created_at DESC);
    `,
  },
];
