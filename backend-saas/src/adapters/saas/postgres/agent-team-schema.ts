export interface PostgresAgentTeamMigration {
  version: number;
  name: string;
  sql: string;
}

export const POSTGRES_AGENT_TEAM_MIGRATIONS: PostgresAgentTeamMigration[] = [
  {
    version: 1,
    name: "agent_team_config",
    sql: `
      CREATE TABLE IF NOT EXISTS agent_team_index (
        tenant_id TEXT PRIMARY KEY,
        active_team TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS agent_teams (
        tenant_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        document JSONB NOT NULL,
        location TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, team_name)
      );
      CREATE INDEX IF NOT EXISTS agent_teams_tenant_idx ON agent_teams(tenant_id);
    `,
  },
];
