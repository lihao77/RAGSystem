/** PostgreSQL schema for the first SaaS run-state slice. */
export interface PostgresRunMigration {
  version: number;
  name: string;
  sql: string;
}

const tenantScopedRunSchema = `
      CREATE TABLE IF NOT EXISTS saas_runs (
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        entrypoint TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        task_summary TEXT,
        request_id TEXT,
        user_id TEXT,
        agent_name TEXT,
        agent_call_id TEXT NOT NULL,
        lineage_parent_call_id TEXT,
        agent_display_name TEXT NOT NULL,
        lease_root_run_id TEXT NOT NULL,
        thread_key TEXT NOT NULL DEFAULT 'root',
        parent_run_id TEXT,
        parent_call_id TEXT,
        child_agent_id TEXT,
        final_message_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, run_id),
        FOREIGN KEY (tenant_id, session_id)
          REFERENCES conversation_sessions(tenant_id, session_id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, parent_run_id)
          REFERENCES saas_runs(tenant_id, run_id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS saas_runs_session_created_idx
        ON saas_runs(tenant_id, session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS saas_runs_parent_idx
        ON saas_runs(tenant_id, session_id, parent_run_id);
      CREATE UNIQUE INDEX IF NOT EXISTS saas_runs_agent_call_idx
        ON saas_runs(tenant_id, session_id, agent_call_id);
      CREATE INDEX IF NOT EXISTS saas_runs_lease_root_status_idx
        ON saas_runs(tenant_id, session_id, lease_root_run_id, status);

      CREATE TABLE IF NOT EXISTS saas_run_steps (
        id BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT,
        step_order INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, session_id, run_id, step_order),
        FOREIGN KEY (tenant_id, run_id)
          REFERENCES saas_runs(tenant_id, run_id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, session_id)
          REFERENCES conversation_sessions(tenant_id, session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS saas_run_steps_run_idx
        ON saas_run_steps(tenant_id, session_id, run_id, step_order);
      CREATE INDEX IF NOT EXISTS saas_run_steps_message_idx
        ON saas_run_steps(tenant_id, session_id, message_id);
`;

export const POSTGRES_RUN_MIGRATIONS: readonly PostgresRunMigration[] = [
  {
    version: 1,
    name: "run-state-core",
    sql: tenantScopedRunSchema,
  },
  {
    version: 2,
    name: "tenant-scoped-run-state-rebuild",
    sql: `
      DROP TABLE IF EXISTS saas_run_steps;
      DROP TABLE IF EXISTS saas_runs;
      ${tenantScopedRunSchema}
    `,
  },
  {
    version: 3,
    name: "remove-duplicate-saas-boundary-messages",
    sql: `
      WITH canonical AS (
        SELECT DISTINCT ON (run.tenant_id, run.run_id)
          run.tenant_id,
          run.run_id,
          message.id
        FROM saas_runs AS run
        JOIN conversation_messages AS message
          ON message.session_id = run.session_id
          AND message.metadata->>'run_id' = run.run_id
        WHERE run.final_message_id = run.run_id || ':final'
          AND message.role = 'assistant'
          AND message.metadata->>'msg_type' = 'assistant_final'
          AND message.metadata->>'saas_boundary' IS DISTINCT FROM 'true'
        ORDER BY run.tenant_id, run.run_id, message.seq DESC
      )
      UPDATE saas_runs AS run
      SET final_message_id = canonical.id
      FROM canonical
      WHERE run.tenant_id = canonical.tenant_id
        AND run.run_id = canonical.run_id;

      DELETE FROM conversation_messages AS boundary
      WHERE boundary.role = 'assistant'
        AND boundary.metadata->>'saas_boundary' = 'true'
        AND EXISTS (
          SELECT 1
          FROM conversation_messages AS canonical
          WHERE canonical.session_id = boundary.session_id
            AND canonical.role = 'assistant'
            AND canonical.metadata->>'run_id' = boundary.metadata->>'run_id'
            AND canonical.metadata->>'msg_type' = 'assistant_final'
            AND canonical.metadata->>'saas_boundary' IS DISTINCT FROM 'true'
        );
    `,
  },
  {
    version: 4,
    name: "run-step-event-idempotency",
    sql: `
      ALTER TABLE saas_run_steps
        ADD COLUMN IF NOT EXISTS event_id TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS saas_run_steps_tenant_event_id_idx
        ON saas_run_steps(tenant_id, event_id)
        WHERE event_id IS NOT NULL;
    `,
  },
  {
    version: 5,
    name: "root-run-owner-lease",
    sql: `
      ALTER TABLE saas_runs
        ADD COLUMN IF NOT EXISTS owner_instance_id TEXT,
        ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS saas_runs_expired_root_lease_idx
        ON saas_runs(tenant_id, lease_expires_at)
        WHERE parent_run_id IS NULL AND status = 'running';
      `,
  },
  {
    version: 6,
    name: "run-terminal-reason",
    sql: `
      ALTER TABLE saas_runs
        ADD COLUMN IF NOT EXISTS terminal_reason TEXT;
    `,
  },
  {
    version: 7,
    name: "run-lifecycle-identity",
    sql: `
      ALTER TABLE saas_runs
        ADD COLUMN IF NOT EXISTS agent_call_id TEXT,
        ADD COLUMN IF NOT EXISTS lineage_parent_call_id TEXT,
        ADD COLUMN IF NOT EXISTS agent_display_name TEXT,
        ADD COLUMN IF NOT EXISTS lease_root_run_id TEXT;
      WITH RECURSIVE run_roots(tenant_id, run_id, lease_root_run_id) AS (
        SELECT tenant_id, run_id, run_id FROM saas_runs WHERE parent_run_id IS NULL
        UNION ALL
        SELECT child.tenant_id, child.run_id, parent.lease_root_run_id
        FROM saas_runs AS child
        JOIN run_roots AS parent
          ON child.tenant_id = parent.tenant_id AND child.parent_run_id = parent.run_id
      )
      UPDATE saas_runs AS run
      SET agent_call_id = COALESCE(NULLIF(run.agent_call_id, ''), run.run_id),
          agent_display_name = COALESCE(NULLIF(run.agent_display_name, ''), NULLIF(run.agent_name, ''), 'unknown'),
          lease_root_run_id = COALESCE(NULLIF(run.lease_root_run_id, ''), roots.lease_root_run_id, run.run_id)
      FROM run_roots AS roots
      WHERE roots.tenant_id = run.tenant_id AND roots.run_id = run.run_id;
      UPDATE saas_runs
      SET agent_call_id = COALESCE(NULLIF(agent_call_id, ''), run_id),
          agent_display_name = COALESCE(NULLIF(agent_display_name, ''), NULLIF(agent_name, ''), 'unknown'),
          lease_root_run_id = COALESCE(NULLIF(lease_root_run_id, ''), run_id)
      WHERE agent_call_id IS NULL OR agent_display_name IS NULL OR lease_root_run_id IS NULL;
      ALTER TABLE saas_runs
        ALTER COLUMN agent_call_id SET NOT NULL,
        ALTER COLUMN agent_display_name SET NOT NULL,
        ALTER COLUMN lease_root_run_id SET NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS saas_runs_agent_call_idx
        ON saas_runs(tenant_id, session_id, agent_call_id);
      CREATE INDEX IF NOT EXISTS saas_runs_lease_root_status_idx
        ON saas_runs(tenant_id, session_id, lease_root_run_id, status);
    `,
  },
];

export function getPendingPostgresRunMigrations(appliedVersion: number): readonly PostgresRunMigration[] {
  if (!Number.isInteger(appliedVersion) || appliedVersion < 0 || appliedVersion > POSTGRES_RUN_MIGRATIONS.length) {
    throw new Error(`invalid PostgreSQL run migration version: ${appliedVersion}`);
  }
  return POSTGRES_RUN_MIGRATIONS.slice(appliedVersion);
}
