export const POSTGRES_PROVIDER_MCP_MIGRATIONS = [
  {
    version: 1,
    name: "provider_mcp_config",
    sql: `
      CREATE TABLE IF NOT EXISTS saas_provider_configs (
        tenant_id TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        config JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, provider_key)
      );
      CREATE INDEX IF NOT EXISTS saas_provider_configs_tenant_idx ON saas_provider_configs(tenant_id);
      CREATE TABLE IF NOT EXISTS saas_mcp_servers (
        tenant_id TEXT NOT NULL,
        server_name TEXT NOT NULL,
        config JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, server_name)
      );
      CREATE INDEX IF NOT EXISTS saas_mcp_servers_tenant_idx ON saas_mcp_servers(tenant_id);
    `,
  },
] as const;
