/** PostgreSQL schema for the first SaaS run-state slice. */
export interface PostgresRunMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_RUN_MIGRATIONS: readonly PostgresRunMigration[] = [
  {
    version: 1,
    name: "run-state-core",
    sql: `
      CREATE TABLE IF NOT EXISTS saas_runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT '',
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
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS saas_runs_session_created_idx
        ON saas_runs(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS saas_runs_parent_idx
        ON saas_runs(session_id, parent_run_id);

      CREATE TABLE IF NOT EXISTS saas_run_steps (
        id BIGSERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT,
        step_order INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, run_id, step_order)
      );
      CREATE INDEX IF NOT EXISTS saas_run_steps_run_idx
        ON saas_run_steps(session_id, run_id, step_order);
      CREATE INDEX IF NOT EXISTS saas_run_steps_message_idx
        ON saas_run_steps(session_id, message_id);
    `,
  },
];

export function getPendingPostgresRunMigrations(appliedVersion: number): readonly PostgresRunMigration[] {
  if (!Number.isInteger(appliedVersion) || appliedVersion < 0 || appliedVersion > POSTGRES_RUN_MIGRATIONS.length) {
    throw new Error(`invalid PostgreSQL run migration version: ${appliedVersion}`);
  }
  return POSTGRES_RUN_MIGRATIONS.slice(appliedVersion);
}
