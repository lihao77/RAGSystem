export interface PostgresAnalyticsMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_ANALYTICS_MIGRATIONS: readonly PostgresAnalyticsMigration[] = [{
  version: 1,
  name: "tenant-agent-call-metrics",
  sql: `
    CREATE TABLE IF NOT EXISTS saas_agent_call_metrics (
      metric_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      model TEXT,
      session_id TEXT,
      run_id TEXT,
      task_id TEXT,
      execution_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
      token_in INTEGER NOT NULL DEFAULT 0 CHECK (token_in >= 0),
      token_out INTEGER NOT NULL DEFAULT 0 CHECK (token_out >= 0),
      tool_usage JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tool_usage) = 'object'),
      error_type TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS saas_agent_call_metrics_tenant_started_idx
      ON saas_agent_call_metrics(tenant_id, started_at);
    CREATE INDEX IF NOT EXISTS saas_agent_call_metrics_tenant_model_started_idx
      ON saas_agent_call_metrics(tenant_id, model, started_at);
  `,
}];
