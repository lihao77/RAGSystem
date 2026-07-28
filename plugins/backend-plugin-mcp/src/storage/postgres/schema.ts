export const POSTGRES_MCP_MIGRATIONS = [
  {
    version: 1,
    name: "mcp_servers_and_agent_config",
    sql: `
      CREATE TABLE IF NOT EXISTS saas_mcp_servers (
        tenant_id TEXT NOT NULL,
        server_name TEXT NOT NULL,
        config JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, server_name)
      );
      CREATE INDEX IF NOT EXISTS saas_mcp_servers_tenant_idx ON saas_mcp_servers(tenant_id);
      CREATE TABLE IF NOT EXISTS mcp_agent_configs (
        tenant_id TEXT NOT NULL,
        team_name TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        config JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, team_name, agent_name)
      );
    `,
  },
] as const;
