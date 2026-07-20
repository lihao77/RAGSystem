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
];

export function getPendingPostgresRunMigrations(appliedVersion: number): readonly PostgresRunMigration[] {
  if (!Number.isInteger(appliedVersion) || appliedVersion < 0 || appliedVersion > POSTGRES_RUN_MIGRATIONS.length) {
    throw new Error(`invalid PostgreSQL run migration version: ${appliedVersion}`);
  }
  return POSTGRES_RUN_MIGRATIONS.slice(appliedVersion);
}
